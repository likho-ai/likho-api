/**
 * Imports: a call asked for by its id in an external system (the dialer). The request goes to
 * the bus as likho.import.requested; a connector fetches the call, uploads it like any file and
 * answers with likho.import.completed or likho.import.failed. The recording then follows the
 * usual path (media ready, a job, a transcript).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { BusService, event } from '../bus/bus.service.js';
import { newId } from '../common/ids.js';
import { invalid, notFound } from '../common/errors.js';
import { CONFIG, type Config } from '../config/config.js';
import { DbService } from '../db/db.module.js';
import { ImportStatus, imports } from '../db/schema.js';
import { LiveService } from '../live/live.service.js';
import { SOURCE_PATTERN } from '../recordings/recordings.service.js';

export type ImportRow = typeof imports.$inferSelect;

const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const PAGE_LIMIT = 100;

@Injectable()
export class ImportsService {
  private readonly log = new Logger('imports');

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly dbs: DbService,
    private readonly bus: BusService,
    private readonly live: LiveService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  /** Asks the connector for a call. The same call asked for again while it is pending is not asked twice. */
  async request(
    workspaceId: string,
    userId: string | null,
    input: { externalId: string; source?: string; transcribe?: boolean },
  ): Promise<ImportRow> {
    const source = (input.source ?? this.config.IMPORT_SOURCE).trim();
    if (!source) throw invalid('Importing from a dialer is not set up (IMPORT_SOURCE).');
    if (!SOURCE_PATTERN.test(source)) throw invalid('source is a short lowercase name.');
    const externalId = input.externalId.trim();
    if (!EXTERNAL_ID.test(externalId))
      throw invalid('The call id is letters, digits, dots, dashes, underscores or colons.');

    const [pending] = await this.db
      .select()
      .from(imports)
      .where(
        and(
          eq(imports.workspaceId, workspaceId),
          eq(imports.source, source),
          eq(imports.externalId, externalId),
          eq(imports.status, 'requested'),
        ),
      )
      .limit(1);
    if (pending) return pending;

    const [row] = await this.db
      .insert(imports)
      .values({
        id: newId('imp'),
        workspaceId,
        source,
        externalId,
        transcribe: input.transcribe ?? true,
        requestedBy: userId,
      })
      .returning();
    await this.bus.publish(
      'likho.import.requested',
      event('likho.import.requested.v1', row!.id, {
        request_id: row!.id,
        workspace_id: workspaceId,
        source,
        external_id: externalId,
        ...(userId ? { requested_by: userId } : {}),
        transcribe: row!.transcribe,
      }),
    );
    await this.live.publish({ kind: 'import', recordingId: '', workspaceId, data: this.liveData(row!) });
    return row!;
  }

  async get(workspaceId: string, id: string): Promise<ImportRow> {
    const [row] = await this.db
      .select()
      .from(imports)
      .where(and(eq(imports.workspaceId, workspaceId), eq(imports.id, id)));
    if (!row) throw notFound('No such import.');
    return row;
  }

  async list(
    workspaceId: string,
    options: { status?: ImportStatus[]; after?: string; limit?: number } = {},
  ): Promise<{ items: ImportRow[]; hasMore: boolean }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), PAGE_LIMIT);
    const conditions = [eq(imports.workspaceId, workspaceId)];
    if (options.status?.length) conditions.push(inArray(imports.status, options.status));
    if (options.after) {
      const cursor = await this.get(workspaceId, options.after);
      conditions.push(lt(imports.createdAt, cursor.createdAt));
    }
    const rows = await this.db
      .select()
      .from(imports)
      .where(and(...conditions))
      .orderBy(desc(imports.createdAt), desc(imports.id))
      .limit(limit + 1);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  /** The connector stored the call as a recording. */
  async onCompleted(requestId: string, recordingId: string): Promise<void> {
    await this.finish(requestId, { status: 'completed', recordingId });
  }

  /** The connector could not fetch the call. */
  async onFailed(requestId: string, code: string, reason: string): Promise<void> {
    await this.finish(requestId, { status: 'failed', code, reason });
  }

  private async finish(
    requestId: string,
    change: { status: ImportStatus; recordingId?: string; code?: string; reason?: string },
  ): Promise<void> {
    const [row] = await this.db
      .update(imports)
      .set({ ...change, updatedAt: new Date() })
      .where(eq(imports.id, requestId))
      .returning();
    if (!row) {
      this.log.warn(`import ${requestId} answered but unknown here`);
      return;
    }
    await this.live.publish({
      kind: 'import',
      recordingId: row.recordingId,
      workspaceId: row.workspaceId,
      data: this.liveData(row),
    });
  }

  private liveData(row: ImportRow): Record<string, unknown> {
    return {
      id: row.id,
      source: row.source,
      externalId: row.externalId,
      status: row.status,
      recordingId: row.recordingId,
      reason: row.reason,
      code: row.code,
    };
  }
}
