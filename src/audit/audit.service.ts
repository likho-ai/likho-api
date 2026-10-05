/**
 * The audit log: who changed what, when. Every mutation a person or an API key makes writes one
 * entry; admins read them. Details hold what changed in plain fields, never a secret.
 */
import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Principal } from '../auth/auth.service.js';
import { newId } from '../common/ids.js';
import { notFound } from '../common/errors.js';
import { DbService } from '../db/db.module.js';
import { auditLog } from '../db/schema.js';

export type AuditRow = typeof auditLog.$inferSelect;

export interface AuditTarget {
  kind: string;
  id: string;
}

export interface AuditFilter {
  action?: string;
  targetKind?: string;
  targetId?: string;
  actorId?: string;
  after?: string;
  limit?: number;
}

const PAGE_LIMIT = 200;

@Injectable()
export class AuditService {
  private readonly log = new Logger('audit');

  constructor(private readonly dbs: DbService) {}

  private get db() {
    return this.dbs.db;
  }

  /**
   * Writes one entry after a change has happened. A failure to write is logged, not thrown: the
   * change itself is done, and the person is not told it failed because the log did.
   */
  async record(
    me: Principal,
    action: string,
    target: AuditTarget,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        id: newId('aud'),
        workspaceId: me.workspaceId,
        actorKind: me.kind,
        actorId: me.userId ?? me.apiKeyId ?? '',
        actorName: me.kind === 'api_key' ? `API key "${me.name}"` : me.name,
        action,
        targetKind: target.kind,
        targetId: target.id,
        details,
        ip: me.ip ?? '',
      });
    } catch (error) {
      this.log.error(
        `could not record ${action} on ${target.kind} ${target.id}: ${(error as Error).message}`,
      );
    }
  }

  async get(workspaceId: string, id: string): Promise<AuditRow> {
    const [row] = await this.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, id)));
    if (!row) throw notFound('That audit entry');
    return row;
  }

  /** Entries of the workspace, newest first. */
  async list(
    workspaceId: string,
    filter: AuditFilter = {},
  ): Promise<{ items: AuditRow[]; hasMore: boolean }> {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), PAGE_LIMIT);
    const conditions = [eq(auditLog.workspaceId, workspaceId)];
    if (filter.action) conditions.push(eq(auditLog.action, filter.action));
    if (filter.targetKind) conditions.push(eq(auditLog.targetKind, filter.targetKind));
    if (filter.targetId) conditions.push(eq(auditLog.targetId, filter.targetId));
    if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
    if (filter.after) {
      const cursor = await this.get(workspaceId, filter.after);
      conditions.push(lt(auditLog.id, cursor.id)); // ids sort by time
    }
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.id))
      .limit(limit + 1);
    return { items: rows.slice(0, limit), hasMore: rows.length > limit };
  }
}
