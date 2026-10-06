/**
 * Every setting a workspace has, typed, with its default and its bounds. The values live in the
 * `settings` table (one row per key); the services that act on them read them from
 * GET /api/v1/settings and hear about changes on likho.settings.changed.
 *
 * Who acts on what:
 *   auto_transcribe        likho-api: queue a job as soon as a recording is ready
 *   dialer.*               the dialer connector: its schedule, the policy, the budget, the write-back
 */
import { invalid } from '../common/errors.js';

export interface DialerSettings {
  /** The schedule runs: new calls are fetched from the dialer every so often. */
  scheduleEnabled: boolean;
  /** The campaigns the schedule takes; empty = every campaign. */
  campaigns: string[];
  /** Calls with less customer talk time than this are not worth a transcription. */
  minTalkSeconds: number;
  /** How many calls the schedule fetches a day at most (one CPU is finite). */
  dailyLimit: number;
  /** How many calls one run of the schedule fetches at most. */
  batchLimit: number;
  /** How often the schedule looks for new calls. */
  pollIntervalSeconds: number;
  /** How many digits of a phone number are kept; 0 = no phone at all. */
  phoneDigits: number;
  /** Transcripts are written back to the CRM. */
  writebackEnabled: boolean;
}

export interface WorkspaceSettings {
  autoTranscribe: boolean;
  dialer: DialerSettings;
}

export const DEFAULTS: WorkspaceSettings = {
  autoTranscribe: true,
  dialer: {
    scheduleEnabled: false,
    campaigns: [],
    minTalkSeconds: 20,
    dailyLimit: 200,
    batchLimit: 50,
    pollIntervalSeconds: 300,
    phoneDigits: 4,
    writebackEnabled: false,
  },
};

type Leaf =
  | { kind: 'boolean' }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'strings'; maxItems: number; maxLength: number };

/** Key in the table → where it sits in the settings object, and what it may hold. */
export const CATALOGUE: Record<
  string,
  { path: [keyof WorkspaceSettings] | ['dialer', keyof DialerSettings]; leaf: Leaf }
> = {
  auto_transcribe: { path: ['autoTranscribe'], leaf: { kind: 'boolean' } },
  'dialer.schedule_enabled': { path: ['dialer', 'scheduleEnabled'], leaf: { kind: 'boolean' } },
  'dialer.campaigns': {
    path: ['dialer', 'campaigns'],
    leaf: { kind: 'strings', maxItems: 200, maxLength: 200 },
  },
  'dialer.min_talk_seconds': {
    path: ['dialer', 'minTalkSeconds'],
    leaf: { kind: 'integer', min: 0, max: 3600 },
  },
  'dialer.daily_limit': { path: ['dialer', 'dailyLimit'], leaf: { kind: 'integer', min: 1, max: 100_000 } },
  'dialer.batch_limit': { path: ['dialer', 'batchLimit'], leaf: { kind: 'integer', min: 1, max: 1000 } },
  'dialer.poll_interval_seconds': {
    path: ['dialer', 'pollIntervalSeconds'],
    leaf: { kind: 'integer', min: 30, max: 86_400 },
  },
  'dialer.phone_digits': { path: ['dialer', 'phoneDigits'], leaf: { kind: 'integer', min: 0, max: 10 } },
  'dialer.writeback_enabled': { path: ['dialer', 'writebackEnabled'], leaf: { kind: 'boolean' } },
};

export const KEYS = Object.keys(CATALOGUE);

/** Reads a value at a path of the settings object. */
export function get(settings: WorkspaceSettings, path: (typeof CATALOGUE)[string]['path']): unknown {
  return path.length === 1 ? settings[path[0]] : settings.dialer[path[1]];
}

/** Writes a value at a path of the settings object. */
export function set(
  settings: WorkspaceSettings,
  path: (typeof CATALOGUE)[string]['path'],
  value: unknown,
): void {
  if (path.length === 1) (settings as unknown as Record<string, unknown>)[path[0]] = value;
  else (settings.dialer as unknown as Record<string, unknown>)[path[1]] = value;
}

/** Checks a stored or proposed value against the key's leaf; returns it cleaned, or throws `invalid`. */
export function check(key: string, value: unknown): unknown {
  const entry = CATALOGUE[key];
  if (!entry) throw invalid(`There is no setting ${key}.`);
  const { leaf } = entry;
  switch (leaf.kind) {
    case 'boolean':
      if (typeof value !== 'boolean') throw invalid(`${key} is on or off.`);
      return value;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < leaf.min || value > leaf.max)
        throw invalid(`${key} is a whole number from ${leaf.min} to ${leaf.max}.`);
      return value;
    case 'strings': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
        throw invalid(`${key} is a list of names.`);
      const cleaned = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
      if (cleaned.length > leaf.maxItems) throw invalid(`${key} holds at most ${leaf.maxItems} names.`);
      if (cleaned.some((v) => v.length > leaf.maxLength))
        throw invalid(`A name in ${key} is at most ${leaf.maxLength} characters.`);
      return cleaned;
    }
  }
}

/** A deep copy of the defaults, to fill in. */
export function defaults(): WorkspaceSettings {
  return { ...DEFAULTS, dialer: { ...DEFAULTS.dialer, campaigns: [...DEFAULTS.dialer.campaigns] } };
}
