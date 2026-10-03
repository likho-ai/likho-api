/**
 * The tables likho-api owns (PostgreSQL, database likho_api). Audio, transcripts and vocabulary
 * live in their own services; this is who people are, what they uploaded, and what was asked.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const now = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text('password_hash').notNull(),
  /** 'admin' may manage users and settings; 'member' works with recordings. */
  role: text().notNull().default('member'),
  createdAt: now(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
});

export const sessions = pgTable(
  'sessions',
  {
    /** A hash of the cookie value; the value itself is only in the browser. */
    id: text().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: now(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent').notNull().default(''),
  },
  (table) => [index('sessions_user').on(table.userId)],
);

export const workspaces = pgTable('workspaces', {
  id: text().primaryKey(),
  name: text().notNull(),
  createdAt: now(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().notNull().default('member'),
    createdAt: now(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.userId] })],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text().primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** A hash of the key; the key itself is shown once, when it is made. */
    hash: text().notNull().unique(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: now(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('api_keys_workspace').on(table.workspaceId)],
);

/** What a recording is going through. */
export const RECORDING_STATUSES = [
  'uploading', // an upload link was handed out
  'uploaded', // the file arrived; likho-media is looking at it
  'ready', // it is audio; it can be transcribed
  'failed', // it is not audio that can be read
  'queued', // a job waits for a worker
  'transcribing', // a worker is on it
  'done', // a transcript exists
] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const recordings = pgTable(
  'recordings',
  {
    id: text().primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    originalName: text('original_name').notNull(),
    /** The file in likho-media. */
    mediaId: text('media_id').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    sha256: text().notNull().default(''),
    durationSeconds: doublePrecision('duration_seconds').notNull().default(0),
    channels: bigint({ mode: 'number' }).notNull().default(0),
    sampleRate: bigint('sample_rate', { mode: 'number' }).notNull().default(0),
    /** 'upload' (a person in the browser), 'api' (a script or connector), 'dialer'. */
    source: text().notNull().default('upload'),
    /** The caller's own id for the call, for connectors. */
    externalId: text('external_id').notNull().default(''),
    /** Facts about the call from where it came (campaign, agent, disposition, call time, ...). */
    attributes: jsonb()
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text().$type<RecordingStatus>().notNull().default('uploading'),
    failureReason: text('failure_reason').notNull().default(''),
    latestTranscriptId: text('latest_transcript_id').notNull().default(''),
    detectedLanguage: text('detected_language').notNull().default(''),
    languageProbability: doublePrecision('language_probability').notNull().default(0),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: now(),
    updatedAt: now(),
  },
  (table) => [
    index('recordings_workspace_created').on(table.workspaceId, table.createdAt),
    index('recordings_workspace_status').on(table.workspaceId, table.status),
    uniqueIndex('recordings_media').on(table.mediaId),
    index('recordings_external').on(table.workspaceId, table.externalId),
  ],
);

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = pgTable(
  'jobs',
  {
    id: text().primaryKey(),
    recordingId: text('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    /** Empty = the transcription service's default model. */
    modelRegistryId: text('model_registry_id').notNull().default(''),
    languagePolicy: text('language_policy').notNull().default('auto'),
    force: boolean().notNull().default(false),
    status: text().$type<JobStatus>().notNull().default('queued'),
    progressSeconds: doublePrecision('progress_seconds').notNull().default(0),
    totalSeconds: doublePrecision('total_seconds').notNull().default(0),
    errorCode: text('error_code').notNull().default(''),
    errorMessage: text('error_message').notNull().default(''),
    transcriptId: text('transcript_id').notNull().default(''),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: now(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('jobs_recording').on(table.recordingId, table.createdAt),
    index('jobs_workspace_status').on(table.workspaceId, table.status),
  ],
);

export const settings = pgTable(
  'settings',
  {
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    value: jsonb()
      .notNull()
      .default(sql`'null'::jsonb`),
    updatedAt: now(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.key] })],
);

/** A call asked for by its id in an external system (the dialer); a connector fetches it. */
export const IMPORT_STATUSES = ['requested', 'completed', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const imports = pgTable(
  'imports',
  {
    id: text().primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Which connector: 'ameyo'. */
    source: text().notNull(),
    externalId: text('external_id').notNull(),
    transcribe: boolean().notNull().default(true),
    status: text().$type<ImportStatus>().notNull().default('requested'),
    recordingId: text('recording_id').notNull().default(''),
    /** Why it failed, for a person; and the connector's code (not_found, no_recording, ...). */
    reason: text().notNull().default(''),
    code: text().notNull().default(''),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: now(),
    updatedAt: now(),
  },
  (table) => [
    index('imports_workspace_created').on(table.workspaceId, table.createdAt),
    index('imports_workspace_external').on(table.workspaceId, table.source, table.externalId),
  ],
);

/** Events already acted on, so an event delivered twice changes nothing twice. */
export const handledEvents = pgTable('handled_events', {
  id: text().primaryKey(),
  handledAt: now(),
});
