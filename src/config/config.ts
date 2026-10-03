/**
 * Settings, read from environment variables. The defaults match the likho-infra local stack,
 * so nothing has to be set on a developer's machine.
 */
import { z } from 'zod';

const port = z.coerce.number().int().min(0).max(65535);
const seconds = z.coerce.number().int().min(1);

export const DEV_SESSION_SECRET = 'likho-dev-session-secret';

const schema = z.object({
  LIKHO_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  HTTP_PORT: port.default(4000),

  DATABASE_URL: z.string().default('postgres://likho_api:likho_api@localhost:5433/likho_api'),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  NATS_URL: z.string().default('nats://localhost:4222'),

  MEDIA_GRPC_ADDR: z.string().default('localhost:5010'),
  TRANSCRIPTION_GRPC_ADDR: z.string().default('localhost:5020'),
  LANGUAGE_GRPC_ADDR: z.string().default('localhost:5030'),
  RPC_TIMEOUT_SECONDS: seconds.default(10),

  /** The address browsers use. Cookies are marked Secure when it is https. */
  PUBLIC_ORIGIN: z.string().default('http://localhost:8080'),
  /** Signs nothing yet, but lets a session store be rotated later. Must be set in production. */
  SESSION_SECRET: z.string().min(16).default(DEV_SESSION_SECRET),
  SESSION_DAYS: seconds.default(30),

  /** Created on first start when there are no users at all. */
  BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().default('Admin'),
  BOOTSTRAP_WORKSPACE_NAME: z.string().default('Likho'),

  /** Take events from the bus (recordings becoming ready, jobs finishing). Off = only the API. */
  CONSUMERS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** A durable consumer name per instance group; instances with the same name share the work. */
  CONSUMER_GROUP: z.string().default('likho-api'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`configuration: ${problems.join('; ')}`);
  }
  const config = parsed.data;
  if (config.LIKHO_ENV === 'production' && config.SESSION_SECRET === DEV_SESSION_SECRET) {
    throw new Error('configuration: SESSION_SECRET must be set in production');
  }
  if ((config.BOOTSTRAP_ADMIN_EMAIL === undefined) !== (config.BOOTSTRAP_ADMIN_PASSWORD === undefined)) {
    throw new Error('configuration: BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD go together');
  }
  return config;
}

/** Injection token for the Config object. */
export const CONFIG = Symbol('CONFIG');
