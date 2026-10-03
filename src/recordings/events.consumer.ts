/**
 * What the other services tell us, and what it means for a recording.
 *
 *   likho.media.ready / failed            the file is audio, or not
 *   likho.live.segment                    a line was transcribed (to the browsers, and progress)
 *   likho.transcription.completed/failed  a job ended
 *
 * Every event is applied once: ids are remembered, so a redelivery changes nothing twice.
 */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BusService, CloudEvent } from '../bus/bus.service.js';
import { CONFIG, type Config } from '../config/config.js';
import { DbService } from '../db/db.module.js';
import { handledEvents, jobs } from '../db/schema.js';
import { LiveService } from '../live/live.service.js';
import { RecordingsService } from './recordings.service.js';

type Data = Record<string, any>;

@Injectable()
export class EventsConsumer implements OnModuleInit {
  private readonly log = new Logger('events');
  private readonly lastProgress = new Map<string, number>();

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly bus: BusService,
    private readonly dbs: DbService,
    private readonly recordings: RecordingsService,
    private readonly live: LiveService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.CONSUMERS_ENABLED) return;
    await this.bus.consume({
      stream: 'LIKHO',
      durable: 'media-ready',
      subject: 'likho.media.ready',
      handler: this.once((data) =>
        this.recordings.onMediaReady(data.media_id, {
          durationSeconds: Number(data.duration_seconds ?? 0),
          channels: Number(data.channels ?? 0),
          sampleRate: Number(data.sample_rate ?? 0),
        }),
      ),
    });
    await this.bus.consume({
      stream: 'LIKHO',
      durable: 'media-failed',
      subject: 'likho.media.failed',
      handler: this.once((data) => this.recordings.onMediaFailed(data.media_id, String(data.message ?? ''))),
    });
    await this.bus.consume({
      stream: 'LIKHO',
      durable: 'transcription-completed',
      subject: 'likho.transcription.completed',
      handler: this.once((data) =>
        this.recordings.onJobCompleted(data.job_id, {
          transcriptId: String(data.transcript_id),
          detectedLanguage: String(data.language?.detected ?? ''),
          languageProbability: Number(data.language?.probability ?? 0),
          audioSeconds: Number(data.stats?.audio_seconds ?? 0),
        }),
      ),
    });
    await this.bus.consume({
      stream: 'LIKHO',
      durable: 'transcription-failed',
      subject: 'likho.transcription.failed',
      handler: this.once((data) =>
        this.recordings.onJobFailed(data.job_id, String(data.code), String(data.message ?? '')),
      ),
    });
    // Live lines are only useful now: no need to catch up on old ones.
    await this.bus.consume({
      stream: 'LIKHO_LIVE',
      durable: 'live-segment',
      subject: 'likho.live.segment',
      from: 'new',
      handler: (event) => this.onSegment(event),
    });
  }

  /** Wraps a handler so that an event id is acted on once. */
  private once(apply: (data: Data) => Promise<void>) {
    return async (event: CloudEvent): Promise<void> => {
      const fresh = await this.dbs.db
        .insert(handledEvents)
        .values({ id: event.id })
        .onConflictDoNothing()
        .returning();
      if (fresh.length === 0) return;
      try {
        await apply(event.data as Data);
      } catch (error) {
        await this.dbs.db.delete(handledEvents).where(eq(handledEvents.id, event.id));
        throw error;
      }
    };
  }

  private async onSegment(event: CloudEvent): Promise<void> {
    const data = event.data as Data;
    const jobId = String(data.job_id);
    const segment = data.segment as Data;
    const total = Number(data.total_seconds ?? 0);
    const [job] = await this.dbs.db
      .select({ recordingId: jobs.recordingId, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId));
    if (!job) return; // a job of another installation sharing the bus, or one deleted
    await this.live.publish({
      kind: 'segment',
      jobId,
      recordingId: job.recordingId,
      data: {
        index: segment.index,
        startSeconds: segment.start_seconds,
        endSeconds: segment.end_seconds,
        textScript: segment.text_script,
        textRoman: segment.text_roman,
        totalSeconds: total,
      },
    });
    // Progress is written at most every few seconds per job; the lines themselves are not stored here.
    const now = Date.now();
    if (now - (this.lastProgress.get(jobId) ?? 0) > 3_000) {
      this.lastProgress.set(jobId, now);
      if (job.status === 'queued') await this.recordings.onJobStarted(jobId, total);
      await this.recordings.onJobProgress(jobId, Number(segment.end_seconds ?? 0), total);
    }
  }
}
