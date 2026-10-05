/** Searches kept for later: the words and the filter, shared by everyone in the workspace. */
import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { newId } from '../common/ids.js';
import { forbidden, invalid, notFound } from '../common/errors.js';
import { DbService } from '../db/db.module.js';
import { savedSearches } from '../db/schema.js';
import type { Principal } from '../auth/auth.service.js';

export type SavedSearchRow = typeof savedSearches.$inferSelect;

/** The filter fields a saved search keeps; dates are stored as ISO text. */
const TEXT_FIELDS = ['language', 'recordingId', 'campaign', 'agent', 'disposition', 'source'] as const;
const DATE_FIELDS = ['since', 'until', 'callSince', 'callUntil'] as const;

export type SavedFilter = Partial<Record<(typeof TEXT_FIELDS)[number], string>> &
  Partial<Record<(typeof DATE_FIELDS)[number], Date>>;

/** The stored map, back into a filter with real dates. */
export function filterOf(row: SavedSearchRow): SavedFilter {
  const out: SavedFilter = {};
  for (const key of TEXT_FIELDS) if (row.filter[key]) out[key] = row.filter[key];
  for (const key of DATE_FIELDS) {
    const text = row.filter[key];
    if (text) {
      const date = new Date(text);
      if (!Number.isNaN(date.getTime())) out[key] = date;
    }
  }
  return out;
}

@Injectable()
export class SavedSearchesService {
  constructor(private readonly dbs: DbService) {}

  private get db() {
    return this.dbs.db;
  }

  async list(workspaceId: string): Promise<SavedSearchRow[]> {
    return this.db
      .select()
      .from(savedSearches)
      .where(eq(savedSearches.workspaceId, workspaceId))
      .orderBy(desc(savedSearches.createdAt), desc(savedSearches.id));
  }

  async save(
    me: Principal,
    input: { name: string; query: string; filter?: SavedFilter | null },
  ): Promise<SavedSearchRow> {
    const name = input.name.trim();
    const query = input.query.trim();
    if (!name) throw invalid('A name is required.');
    if (name.length > 80) throw invalid('The name is too long.');
    if (!query) throw invalid('The words to search for are required.');
    if (query.length > 200) throw invalid('The search is too long.');
    const filter: Record<string, string> = {};
    for (const key of TEXT_FIELDS) {
      const value = input.filter?.[key]?.trim();
      if (value) filter[key] = value;
    }
    for (const key of DATE_FIELDS) {
      const value = input.filter?.[key];
      if (value) filter[key] = value.toISOString();
    }
    const [row] = await this.db
      .insert(savedSearches)
      .values({ id: newId('sav'), workspaceId: me.workspaceId, name, query, filter, createdBy: me.userId })
      .returning();
    return row!;
  }

  /** The one who saved it, or an admin, removes it. */
  async remove(me: Principal, id: string): Promise<SavedSearchRow> {
    const [row] = await this.db
      .select()
      .from(savedSearches)
      .where(and(eq(savedSearches.id, id), eq(savedSearches.workspaceId, me.workspaceId)));
    if (!row) throw notFound('The saved search');
    if (row.createdBy !== me.userId && me.role !== 'admin')
      throw forbidden('Only who saved it, or an admin, can remove it.');
    await this.db.delete(savedSearches).where(eq(savedSearches.id, id));
    return row;
  }
}
