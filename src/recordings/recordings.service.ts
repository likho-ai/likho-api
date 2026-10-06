/**
 * Recordings: what was uploaded, where it stands, and the jobs that transcribe it.
 *
 * The audio itself is in likho-media; the transcript is in likho-transcription. This service
 * keeps the list a person sees and moves each recording along as events arrive.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MediaKind } from '@likho-ai/contracts/media/v1/media_pb';
import { and, desc, eq, gte, ilike, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { newId } from '../common/ids.js';
import { invalid, notFound } from '../common/errors.js';
import { CONFIG, type Config } from '../config/config.js';
import { DbService } from '../db/db.module.js';
import {
  JOB_STATUSES,
  jobs,
  RECORDING_STATUSES,
  recordings,
  RecordingStatus,
  settings,
} from '../db/schema.js';
import { BusService, event } from '../bus/bus.service.js';
import { LiveService } from '../live/live.service.js';
import { MetricsService } from '../metrics/metrics.service.js';

export type RecordingRow = typeof recordings.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

export interface UploadRequest {
  originalName: string;
  sizeBytes: number;
  contentType?: string;
  sha256?: string;
  /** 'upload' (a person in the browser), 'api' (a script), or the connector's name ('ameyo'). */
  source: string;
  externalId?: string;
  /** Facts about the call from where it came (campaign, agent, disposition, call time, ...). */
  attributes?: Record<string, string>;
}

/** A source name: short, lowercase, the kind of thing a connector is called. */
export const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ATTRIBUTE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const ATTRIBUTES_MAX = 40;

/** Checks and tidies a recording's attributes. */
export function cleanAttributes(raw: Record<string, unknown> | undefined): Record<string, string> {
  if (!raw) return {};
  const entries = Object.entries(raw);
  if (entries.length > ATTRIBUTES_MAX) throw invalid(`At most ${ATTRIBUTES_MAX} attributes.`);
  const clean: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!ATTRIBUTE_KEY.test(key)) throw invalid(`Attribute names are letters, digits and _: ${key}`);
    const text = value == null ? '' : String(value).trim();
    if (text.length > 500) throw invalid(`Attribute ${key} is too long.`);
    if (text) clean[key] = text;
  }
  return clean;
}

/**
 * When the call happened: the callTime attribute a connector sets (the dialer's text, read in
 * this process's time zone when it carries none), else when the recording was made.
 */
export function callTimeOf(attributes: Record<string, string>, createdAt: Date): Date {
  const text = attributes.callTime?.trim();
  if (text) {
    const parsed = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(' ', 'T') : text);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return createdAt;
}

/** The facts about the calls a list can be narrowed by, besides status and name. */
export interface FactsFilter {
  campaign?: string;
  agent?: string;
  disposition?: string;
  source?: string;
  /** On the call time. */
  since?: Date;
  until?: Date;
}

export const FACET_KEYS = ['campaign', 'agent', 'disposition', 'source'] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

export interface UploadAnswer {
  recording: RecordingRow;
  /** Where to PUT the file. Empty when the same content is already stored. */
  uploadUrl: string;
  expiresAt: Date | null;
  /** The recording that already holds this content, when there is one. */
  duplicateOf: RecordingRow | null;
}

export interface JobRequest {
  modelRegistryId?: string;
  languagePolicy?: string;
  force?: boolean;
}

const PAGE_LIMIT = 100;

@Injectable()
export class RecordingsService {
  private readonly log = new Logger('recordings');

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly dbs: DbService,
    private readonly clients: Clients,
    private readonly bus: BusService,
    private readonly live: LiveService,
    private readonly metrics: MetricsService,
  ) {
    metrics.observeJobs(
      () => this.jobCounts(),
      () => this.oldestQueuedSeconds(),
    );
  }

  private get db() {
    return this.dbs.db;
  }

  // ---------------------------------------------------------------- uploads

  /** Makes a recording and asks likho-media for the link its file is sent to. */
  async requestUpload(
    workspaceId: string,
    userId: string | null,
    input: UploadRequest,
  ): Promise<UploadAnswer> {
    const originalName = input.originalName.trim();
    if (!originalName) throw invalid('A file name is required.');
    if (originalName.length > 255) throw invalid('The file name is too long.');
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0)
      throw invalid('sizeBytes must be a whole number.');
    if (input.sha256 && !/^[0-9a-f]{64}$/.test(input.sha256))
      throw invalid('sha256 must be 64 lowercase hex characters.');
    if (!SOURCE_PATTERN.test(input.source)) throw invalid('source is a short lowercase name.');
    const attributes = cleanAttributes(input.attributes);

    const recordingId = newId('rec');
    let reply;
    try {
      reply = await this.clients.media.createUpload({
        originalName,
        sizeBytes: BigInt(input.sizeBytes),
        contentType: input.contentType ?? '',
        sha256: input.sha256 ?? '',
        workspaceId,
        recordingId,
      });
    } catch (error) {
      throw fromRpc(error, 'media');
    }

    if (reply.existingMedia) {
      // The same content is stored already: point at the recording that has it.
      const [existing] = await this.db
        .select()
        .from(recordings)
        .where(and(eq(recordings.workspaceId, workspaceId), eq(recordings.mediaId, reply.existingMedia.id)));
      if (existing) {
        return { recording: existing, uploadUrl: '', expiresAt: null, duplicateOf: existing };
      }
    }

    const [recording] = await this.db
      .insert(recordings)
      .values({
        id: recordingId,
        workspaceId,
        originalName,
        mediaId: reply.mediaId,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256 ?? '',
        source: input.source,
        externalId: input.externalId?.trim() ?? '',
        attributes,
        callTime: callTimeOf(attributes, new Date()),
        status: reply.existingMedia ? 'ready' : 'uploading',
        createdBy: userId,
      })
      .returning();
    await this.publishUpdated(recording!);
    return {
      recording: recording!,
      uploadUrl: reply.uploadUrl,
      expiresAt: reply.expiresAt ? new Date(Number(reply.expiresAt.seconds) * 1000) : null,
      duplicateOf: null,
    };
  }

  /** Tells likho-search (and whoever else listens) what is known about a recording. */
  private async publishUpdated(recording: RecordingRow): Promise<void> {
    await this.bus.publish(
      'likho.recording.updated',
      event('likho.recording.updated.v1', recording.id, {
        recording_id: recording.id,
        workspace_id: recording.workspaceId,
        source: recording.source,
        external_id: recording.externalId,
        name: recording.originalName,
        call_time: recording.callTime.toISOString(),
        attributes: recording.attributes,
      }),
    );
  }

  /** The conditions a facts filter adds to a query of this workspace's recordings. */
  private factConditions(filter: FactsFilter) {
    const conditions = [];
    for (const key of ['campaign', 'agent', 'disposition'] as const) {
      const value = filter[key]?.trim();
      if (value) conditions.push(sql`${recordings.attributes}->>${key} = ${value}`);
    }
    if (filter.source?.trim()) conditions.push(eq(recordings.source, filter.source.trim()));
    if (filter.since) conditions.push(gte(recordings.callTime, filter.since));
    if (filter.until) conditions.push(lte(recordings.callTime, filter.until));
    return conditions;
  }

  /** The values one fact takes across the workspace's recordings, most common first. */
  async facets(
    workspaceId: string,
    key: FacetKey,
    filter: FactsFilter = {},
  ): Promise<{ value: string; count: number }[]> {
    if (!FACET_KEYS.includes(key)) throw invalid(`The facet is one of ${FACET_KEYS.join(', ')}.`);
    const value =
      key === 'source' ? recordings.source : sql<string>`${recordings.attributes}->>${sql.raw(`'${key}'`)}`;
    const rows = await this.db
      .select({ value, count: sql<number>`count(*)::int` })
      .from(recordings)
      .where(
        and(eq(recordings.workspaceId, workspaceId), sql`${value} <> ''`, ...this.factConditions(filter)),
      )
      .groupBy(value)
      .orderBy(sql`count(*) desc`, value)
      .limit(100);
    return rows.filter((row) => row.value != null && row.value !== '');
  }

  // ---------------------------------------------------------------- reading

  async get(workspaceId: string, id: string): Promise<RecordingRow> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.id, id), eq(recordings.workspaceId, workspaceId)));
    if (!row) throw notFound('The recording');
    return row;
  }

  async byMedia(mediaId: string): Promise<RecordingRow | null> {
    const [row] = await this.db.select().from(recordings).where(eq(recordings.mediaId, mediaId));
    return row ?? null;
  }

  /** Newest first. `after` is the id of the last recording of the previous page. */
  async list(
    workspaceId: string,
    filter: FactsFilter & {
      status?: RecordingStatus[];
      search?: string;
      externalId?: string;
      after?: string;
      limit?: number;
    } = {},
  ): Promise<{ items: RecordingRow[]; hasMore: boolean }> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), PAGE_LIMIT);
    const conditions = [eq(recordings.workspaceId, workspaceId), ...this.factConditions(filter)];
    if (filter.status?.length) {
      for (const status of filter.status) {
        if (!RECORDING_STATUSES.includes(status)) throw invalid(`Unknown status ${status}.`);
      }
      conditions.push(inArray(recordings.status, filter.status));
    }
    if (filter.search?.trim()) {
      const pattern = `%${filter.search.trim().replace(/[%_\\]/g, '\\$&')}%`;
      conditions.push(or(ilike(recordings.originalName, pattern), ilike(recordings.externalId, pattern))!);
    }
    if (filter.externalId?.trim()) conditions.push(eq(recordings.externalId, filter.externalId.trim()));
    if (filter.after) {
      const [cursor] = await this.db
        .select({ createdAt: recordings.createdAt, id: recordings.id })
        .from(recordings)
        .where(and(eq(recordings.id, filter.after), eq(recordings.workspaceId, workspaceId)));
      if (cursor) {
        conditions.push(
          or(
            lt(recordings.createdAt, cursor.createdAt),
            and(eq(recordings.createdAt, cursor.createdAt), lt(recordings.id, cursor.id)),
          )!,
        );
      }
    }
    const rows = await this.db
      .select()
      .from(recordings)
      .where(and(...conditions))
      .orderBy(desc(recordings.createdAt), desc(recordings.id))
      .limit(limit + 1);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  async counts(workspaceId: string): Promise<Record<RecordingStatus, number>> {
    const rows = await this.db
      .select({ status: recordings.status, count: sql<number>`count(*)::int` })
      .from(recordings)
      .where(eq(recordings.workspaceId, workspaceId))
      .groupBy(recordings.status);
    const counts = Object.fromEntries(RECORDING_STATUSES.map((status) => [status, 0])) as Record<
      RecordingStatus,
      number
    >;
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  /** A short-lived link to what a browser plays, or to the waveform. */
  async downloadUrl(recording: RecordingRow, kind: 'audio' | 'peaks' | 'original'): Promise<string> {
    const kinds = { audio: MediaKind.NORMALIZED, peaks: MediaKind.PEAKS, original: MediaKind.ORIGINAL };
    try {
      const reply = await this.clients.media.getDownloadUrl({ id: recording.mediaId, kind: kinds[kind] });
      return reply.url;
    } catch (error) {
      throw fromRpc(error, 'media');
    }
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const recording = await this.get(workspaceId, id);
    try {
      await this.clients.media.deleteMedia({ id: recording.mediaId });
    } catch (error) {
      throw fromRpc(error, 'media');
    }
    await this.db.delete(recordings).where(eq(recordings.id, id));
    // The search index and the connectors forget it too.
    await this.bus.publish(
      'likho.recording.deleted',
      event('likho.recording.deleted.v1', id, {
        recording_id: id,
        workspace_id: workspaceId,
        media_id: recording.mediaId,
      }),
    );
    await this.live.publish({ kind: 'recording', recordingId: id, data: { deleted: true } });
  }

  /** Several recordings by id, for decorating search hits (only this workspace's). */
  async byIds(workspaceId: string, ids: string[]): Promise<Map<string, RecordingRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(recordings)
      .where(and(eq(recordings.workspaceId, workspaceId), inArray(recordings.id, [...new Set(ids)])));
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** The recording a connector made for a call, if any. */
  async byExternalId(workspaceId: string, source: string, externalId: string): Promise<RecordingRow | null> {
    const [row] = await this.db
      .select()
      .from(recordings)
      .where(
        and(
          eq(recordings.workspaceId, workspaceId),
          eq(recordings.source, source),
          eq(recordings.externalId, externalId),
        ),
      )
      .orderBy(desc(recordings.createdAt))
      .limit(1);
    return row ?? null;
  }

  // ---------------------------------------------------------------- jobs

  async createJob(
    workspaceId: string,
    userId: string | null,
    recordingId: string,
    input: JobRequest = {},
  ): Promise<JobRow> {
    const recording = await this.get(workspaceId, recordingId);
    if (!['ready', 'done', 'queued', 'transcribing'].includes(recording.status)) {
      throw invalid(`The recording cannot be transcribed yet: it is ${recording.status}.`);
    }
    const running = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.recordingId, recordingId), inArray(jobs.status, ['queued', 'running'])));
    if (running.length > 0) throw invalid('A job for this recording is already waiting or running.');
    return this.queue(recording, userId, input);
  }

  private async queue(
    recording: RecordingRow,
    userId: string | null,
    input: JobRequest,
    attempt = 1,
  ): Promise<JobRow> {
    const languagePolicy = input.languagePolicy?.trim() || 'auto';
    if (!/^[a-z]{2,8}$/.test(languagePolicy)) throw invalid('languagePolicy is "auto" or a language code.');
    const [job] = await this.db
      .insert(jobs)
      .values({
        id: newId('job'),
        recordingId: recording.id,
        workspaceId: recording.workspaceId,
        modelRegistryId: input.modelRegistryId?.trim() ?? '',
        languagePolicy,
        force: input.force ?? false,
        totalSeconds: recording.durationSeconds,
        attempt,
        createdBy: userId,
        lastProgressAt: new Date(),
      })
      .returning();
    await this.request(job!, recording);
    await this.setRecordingStatus(recording.id, 'queued');
    await this.live.publish({
      kind: 'job',
      jobId: job!.id,
      recordingId: recording.id,
      data: { status: 'queued' },
    });
    this.log.log(
      `job ${job!.id} queued for recording ${recording.id}${attempt > 1 ? ` (try ${attempt})` : ''}`,
    );
    return job!;
  }

  /** Tells the workers about a job. */
  private async request(job: JobRow, recording: Pick<RecordingRow, 'id' | 'mediaId' | 'workspaceId'>) {
    await this.bus.publish(
      'likho.transcription.requested',
      event('likho.transcription.requested.v1', recording.id, {
        job_id: job.id,
        recording_id: recording.id,
        media_id: recording.mediaId,
        workspace_id: recording.workspaceId,
        model_registry_id: job.modelRegistryId,
        language_policy: job.languagePolicy,
        force: job.force,
        attempt: job.attempt,
      }),
    );
  }

  // ---------------------------------------------------------------- stuck and stalled jobs

  /**
   * A job still queued after JOB_QUEUED_MAX_MINUTES is asked for again, once; after that it
   * fails ("no worker"). A running job with no line for JOB_STALL_MAX_MINUTES is stopped and
   * failed ("stalled"), and a fresh job is queued once more. Safe to run on every instance.
   */
  async sweepJobs(now = new Date()): Promise<{ requeued: number; failed: number }> {
    const done = { requeued: 0, failed: 0 };
    const queuedMax = this.config.JOB_QUEUED_MAX_MINUTES;
    const stallMax = this.config.JOB_STALL_MAX_MINUTES;
    const tries = this.config.JOB_MAX_ATTEMPTS;

    const stuck = await this.db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.status, 'queued'), lt(jobs.lastProgressAt, new Date(now.getTime() - queuedMax * 60_000))),
      );
    for (const job of stuck) {
      if (job.asked < 2) {
        const [again] = await this.db
          .update(jobs)
          .set({ asked: job.asked + 1, lastProgressAt: now })
          .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
          .returning();
        if (!again) continue;
        const [recording] = await this.db.select().from(recordings).where(eq(recordings.id, job.recordingId));
        if (!recording) continue;
        await this.request(again, recording);
        this.log.warn(`job ${job.id} was queued for ${queuedMax} min with no worker: asked for again`);
        this.metrics.sweeps.add(1, { outcome: 'requeued' });
        done.requeued++;
      } else {
        await this.onJobFailed(job.id, 'no_worker', `No worker took the job in ${queuedMax} minutes, twice.`);
        this.metrics.sweeps.add(1, { outcome: 'failed' });
        done.failed++;
      }
    }

    const stalled = await this.db
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.status, 'running'), lt(jobs.lastProgressAt, new Date(now.getTime() - stallMax * 60_000))),
      );
    for (const job of stalled) {
      try {
        await this.clients.transcription.cancelJob({ jobId: job.id });
      } catch {
        /* the worker may be gone; that is the point */
      }
      await this.onJobFailed(job.id, 'stalled', `No progress for ${stallMax} minutes.`);
      this.metrics.sweeps.add(1, { outcome: 'failed' });
      done.failed++;
      if (job.attempt < tries) {
        const [recording] = await this.db.select().from(recordings).where(eq(recordings.id, job.recordingId));
        if (!recording) continue;
        await this.queue(
          recording,
          job.createdBy,
          { modelRegistryId: job.modelRegistryId, languagePolicy: job.languagePolicy, force: job.force },
          job.attempt + 1,
        );
        this.log.warn(`job ${job.id} stalled after ${stallMax} min: failed, and tried once more`);
        this.metrics.sweeps.add(1, { outcome: 'requeued' });
        done.requeued++;
      } else {
        this.log.warn(`job ${job.id} stalled after ${stallMax} min on its last try: failed`);
      }
    }
    return done;
  }

  /** For the metrics: jobs by status. */
  async jobCounts(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .groupBy(jobs.status);
    const counts: Record<string, number> = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0]));
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  /** For the metrics: how long the oldest waiting job has waited, in seconds. */
  async oldestQueuedSeconds(): Promise<number> {
    const [row] = await this.db
      .select({ oldest: sql<number | null>`extract(epoch from now() - min(${jobs.createdAt}))` })
      .from(jobs)
      .where(eq(jobs.status, 'queued'));
    return Number(row?.oldest ?? 0);
  }

  async getJob(workspaceId: string, id: string): Promise<JobRow> {
    const [row] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.workspaceId, workspaceId)));
    if (!row) throw notFound('The job');
    return row;
  }

  async listJobs(workspaceId: string, recordingId?: string, status?: JobRow['status'][]): Promise<JobRow[]> {
    const conditions = [eq(jobs.workspaceId, workspaceId)];
    if (recordingId) conditions.push(eq(jobs.recordingId, recordingId));
    if (status?.length) {
      for (const s of status) if (!JOB_STATUSES.includes(s)) throw invalid(`Unknown job status ${s}.`);
      conditions.push(inArray(jobs.status, status));
    }
    return this.db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.createdAt))
      .limit(PAGE_LIMIT);
  }

  async cancelJob(workspaceId: string, id: string): Promise<JobRow> {
    const job = await this.getJob(workspaceId, id);
    if (job.status !== 'queued' && job.status !== 'running') return job;
    // A running job is stopped by its worker; a queued one may be taken before the worker learns.
    try {
      await this.clients.transcription.cancelJob({ jobId: id });
    } catch (error) {
      this.log.warn(`could not ask the worker to stop job ${id}: ${String(error)}`);
    }
    const [updated] = await this.db
      .update(jobs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(jobs.id, id))
      .returning();
    await this.setRecordingStatus(job.recordingId, 'ready');
    await this.live.publish({
      kind: 'job',
      jobId: id,
      recordingId: job.recordingId,
      data: { status: 'cancelled' },
    });
    return updated!;
  }

  // ---------------------------------------------------------------- what the events do

  async setRecordingStatus(
    id: string,
    status: RecordingStatus,
    extra: Partial<RecordingRow> = {},
  ): Promise<void> {
    await this.writeRecordingStatus(this.db, id, status, extra);
    await this.live.publish({ kind: 'recording', recordingId: id, data: { status, ...extra } });
  }

  /** The recording's status written with `db`: the service's connection, or a transaction. */
  private async writeRecordingStatus(
    db: Pick<typeof this.db, 'update'>,
    id: string,
    status: RecordingStatus,
    extra: Partial<RecordingRow> = {},
  ): Promise<void> {
    await db
      .update(recordings)
      .set({ status, updatedAt: new Date(), ...extra })
      .where(eq(recordings.id, id));
  }

  /** likho.media.ready: the file is audio. Queue a job when the workspace wants that. */
  async onMediaReady(
    mediaId: string,
    info: { durationSeconds: number; channels: number; sampleRate: number },
  ): Promise<void> {
    const recording = await this.byMedia(mediaId);
    if (!recording) {
      this.log.warn(`media ${mediaId} is ready but no recording has it`);
      return;
    }
    if (recording.status !== 'uploading' && recording.status !== 'uploaded') return; // seen before
    await this.setRecordingStatus(recording.id, 'ready', info);
    if (await this.autoTranscribe(recording.workspaceId)) {
      await this.queue({ ...recording, ...info, status: 'ready' }, null, {});
    }
  }

  async onMediaFailed(mediaId: string, message: string): Promise<void> {
    const recording = await this.byMedia(mediaId);
    if (!recording) return;
    await this.setRecordingStatus(recording.id, 'failed', { failureReason: message });
  }

  /** A worker took the job (the started event, or the first line). totalSeconds 0 = not known yet. */
  async onJobStarted(jobId: string, totalSeconds: number): Promise<void> {
    // The job and its recording change together, so nobody reads one without the other.
    const job = await this.db.transaction(async (tx) => {
      const [taken] = await tx
        .update(jobs)
        .set({
          status: 'running',
          startedAt: new Date(),
          lastProgressAt: new Date(),
          ...(totalSeconds > 0 ? { totalSeconds } : {}),
        })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
        .returning();
      if (taken) await this.writeRecordingStatus(tx, taken.recordingId, 'transcribing');
      return taken;
    });
    if (!job) {
      // A worker took a request that was given up on in the meantime (a stalled job's request,
      // delivered once more to the worker that came back; a job cancelled while it waited): stop it.
      const [known] = await this.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId));
      if (known && (known.status === 'failed' || known.status === 'cancelled')) {
        try {
          await this.clients.transcription.cancelJob({ jobId });
          this.log.warn(
            `job ${jobId} was started after it was ${known.status}: the worker was asked to drop it`,
          );
        } catch (error) {
          this.log.warn(`could not ask the worker to drop job ${jobId}: ${String(error)}`);
        }
      }
      return;
    }
    await this.live.publish({
      kind: 'recording',
      recordingId: job.recordingId,
      data: { status: 'transcribing' },
    });
    await this.live.publish({
      kind: 'job',
      jobId,
      recordingId: job.recordingId,
      data: { status: 'running', totalSeconds: job.totalSeconds },
    });
  }

  async onJobProgress(jobId: string, progressSeconds: number, totalSeconds: number): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        progressSeconds,
        totalSeconds,
        status: 'running',
        startedAt: sql`coalesce(${jobs.startedAt}, now())`,
        lastProgressAt: new Date(),
      })
      .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['queued', 'running'])));
  }

  async onJobCompleted(
    jobId: string,
    result: {
      transcriptId: string;
      detectedLanguage: string;
      languageProbability: number;
      audioSeconds: number;
    },
  ): Promise<void> {
    const done = {
      latestTranscriptId: result.transcriptId,
      detectedLanguage: result.detectedLanguage,
      languageProbability: result.languageProbability,
      durationSeconds: result.audioSeconds,
    };
    const job = await this.db.transaction(async (tx) => {
      const [finished] = await tx
        .update(jobs)
        .set({
          status: 'done',
          finishedAt: new Date(),
          transcriptId: result.transcriptId,
          progressSeconds: result.audioSeconds,
          totalSeconds: result.audioSeconds,
          errorCode: '',
          errorMessage: '',
        })
        // A transcript is never thrown away: a job given up on (cancelled, stalled) whose worker
        // finished it anyway is done after all.
        .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['queued', 'running', 'cancelled', 'failed'])))
        .returning();
      if (finished) await this.writeRecordingStatus(tx, finished.recordingId, 'done', done);
      return finished;
    });
    if (!job) return;
    this.metrics.jobsFinished.add(1, { status: 'done' });
    const wallSeconds = (job.finishedAt!.getTime() - (job.startedAt ?? job.createdAt).getTime()) / 1000;
    if (wallSeconds > 0 && result.audioSeconds > 0)
      this.metrics.realtimeFactor.record(result.audioSeconds / wallSeconds);
    await this.live.publish({
      kind: 'recording',
      recordingId: job.recordingId,
      data: { status: 'done', ...done },
    });
    await this.live.publish({
      kind: 'job',
      jobId,
      recordingId: job.recordingId,
      data: { status: 'done', transcriptId: result.transcriptId },
    });
  }

  async onJobFailed(jobId: string, code: string, message: string): Promise<void> {
    const status = code === 'cancelled' ? 'cancelled' : 'failed';
    const outcome = await this.db.transaction(async (tx) => {
      const [stopped] = await tx
        .update(jobs)
        .set({ status, finishedAt: new Date(), errorCode: code, errorMessage: message })
        .where(and(eq(jobs.id, jobId), inArray(jobs.status, ['queued', 'running'])))
        .returning();
      if (!stopped) return null;
      const [recording] = await tx.select().from(recordings).where(eq(recordings.id, stopped.recordingId));
      let back: RecordingStatus | null = null;
      if (recording && (recording.status === 'queued' || recording.status === 'transcribing')) {
        // Back to where it was: a transcript from an earlier job still counts.
        back = recording.latestTranscriptId ? 'done' : 'ready';
        await this.writeRecordingStatus(tx, stopped.recordingId, back);
      }
      return { job: stopped, back };
    });
    if (!outcome) return;
    const { job, back } = outcome;
    this.metrics.jobsFinished.add(1, { status });
    if (back)
      await this.live.publish({ kind: 'recording', recordingId: job.recordingId, data: { status: back } });
    await this.live.publish({
      kind: 'job',
      jobId,
      recordingId: job.recordingId,
      data: { status, code, message },
    });
  }

  // ---------------------------------------------------------------- settings

  async autoTranscribe(workspaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.workspaceId, workspaceId), eq(settings.key, 'auto_transcribe')));
    return row ? row.value === true : true;
  }

  async setAutoTranscribe(workspaceId: string, enabled: boolean): Promise<void> {
    await this.db
      .insert(settings)
      .values({ workspaceId, key: 'auto_transcribe', value: enabled })
      .onConflictDoUpdate({
        target: [settings.workspaceId, settings.key],
        set: { value: enabled, updatedAt: new Date() },
      });
  }
}
