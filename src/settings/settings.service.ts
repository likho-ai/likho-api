/**
 * The workspace's settings: read as one typed object (the defaults filled in), changed a few
 * keys at a time. A change is told on the bus (likho.settings.changed, the keys only) so that
 * the services acting on them read the new values.
 */
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { BusService, event } from '../bus/bus.service.js';
import { newId } from '../common/ids.js';
import { DbService } from '../db/db.module.js';
import { settings } from '../db/schema.js';
import { CATALOGUE, KEYS, check, defaults, get, set, type WorkspaceSettings } from './catalogue.js';
import type { SettingsInput } from './settings.graphql.js';

@Injectable()
export class SettingsService {
  constructor(
    private readonly dbs: DbService,
    private readonly bus: BusService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  /** Every setting, the stored value or the default. A stored value that no longer fits is ignored. */
  async read(workspaceId: string): Promise<WorkspaceSettings> {
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(and(eq(settings.workspaceId, workspaceId), inArray(settings.key, KEYS)));
    const result = defaults();
    for (const row of rows) {
      try {
        set(result, CATALOGUE[row.key]!.path, check(row.key, row.value));
      } catch {
        /* an old or hand-edited value: the default stands */
      }
    }
    return result;
  }

  /** Applies the fields of the input that are set; returns the settings after, and the keys that changed. */
  async update(
    workspaceId: string,
    input: SettingsInput,
    changedBy: string | null,
  ): Promise<{ settings: WorkspaceSettings; changed: string[] }> {
    const before = await this.read(workspaceId);
    const proposed: { key: string; value: unknown }[] = [];
    for (const [key, entry] of Object.entries(CATALOGUE)) {
      const raw =
        entry.path.length === 1
          ? (input as Record<string, unknown>)[entry.path[0]]
          : (input.dialer as Record<string, unknown> | undefined)?.[entry.path[1]];
      if (raw === undefined || raw === null) continue;
      const value = check(key, raw);
      if (JSON.stringify(value) !== JSON.stringify(get(before, entry.path))) proposed.push({ key, value });
    }
    if (proposed.length === 0) return { settings: before, changed: [] };
    for (const { key, value } of proposed) {
      await this.db
        .insert(settings)
        .values({ workspaceId, key, value })
        .onConflictDoUpdate({
          target: [settings.workspaceId, settings.key],
          set: { value, updatedAt: new Date() },
        });
    }
    const changed = proposed.map((p) => p.key);
    await this.bus.publish(
      'likho.settings.changed',
      event('likho.settings.changed.v1', workspaceId, {
        workspace_id: workspaceId,
        keys: changed,
        ...(changedBy ? { changed_by: changedBy } : {}),
      }),
    );
    return { settings: await this.read(workspaceId), changed };
  }
}

/** The id an event of this service carries when none fits better. */
export const settingsEventId = () => newId('evt');
