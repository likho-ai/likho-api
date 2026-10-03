/**
 * The service under test: the real application on a free port, against PostgreSQL (its own
 * schema), NATS and Redis from the likho-infra stack, with the three other services faked.
 *
 * Start the stack first:  likho-infra> bash scripts/up.sh   (or .\stack.ps1 up)
 * Without it these tests are skipped locally; with LIKHO_REQUIRE_STACK=1 (set in CI) they fail instead.
 */
import { INestApplication } from '@nestjs/common';
import { connect, JetStreamClient, NatsConnection, StringCodec } from 'nats';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { newId } from '../src/common/ids.js';
import { Config, loadConfig } from '../src/config/config.js';
import { FakeLanguage, FakeMedia, FakeSearch, FakeServer, FakeTranscription, serve } from './fakes.js';

const codec = StringCodec();

export interface Harness {
  app: INestApplication;
  url: string;
  config: Config;
  media: FakeMedia;
  transcription: FakeTranscription;
  language: FakeLanguage;
  search: FakeSearch;
  nats: NatsConnection;
  js: JetStreamClient;
  /** Publishes an event the way the other services do. Returns its id. */
  publish(subject: string, type: string, data: Record<string, unknown>, id?: string): Promise<string>;
  /** Events published on a subject since the harness started (what likho-api itself sends). */
  published(subject: string): Record<string, any>[];
  stop(): Promise<void>;
}

async function reachable(address: string): Promise<boolean> {
  const [host, port] = address.split(':');
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(port), timeout: 1000 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
  });
}

function hostOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port}`;
}

/** Skips (or, in CI, fails) when the stack is not there. */
export async function requireStack(): Promise<boolean> {
  const config = loadConfig({});
  const missing: string[] = [];
  for (const [name, address] of [
    ['PostgreSQL', hostOf(config.DATABASE_URL)],
    ['NATS', hostOf(config.NATS_URL)],
    ['Redis', hostOf(config.REDIS_URL)],
  ]) {
    if (!(await reachable(address!))) missing.push(name!);
  }
  if (missing.length === 0) return true;
  const message = `${missing.join(', ')} not reachable; start the likho-infra stack`;
  if (process.env.LIKHO_REQUIRE_STACK === '1') throw new Error(message);
  console.warn(message + ' (tests skipped)');
  return false;
}

export async function start(overrides: Partial<Config> = {}): Promise<Harness> {
  const base = loadConfig({});
  const schema = 'test_' + randomBytes(6).toString('hex');
  const admin = new pg.Client({ connectionString: base.DATABASE_URL });
  await admin.connect();
  // Schemas of test runs that were interrupted before their clean-up.
  const stale = await admin.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'test_%'`,
  );
  for (const row of stale.rows) await admin.query(`DROP SCHEMA ${row.nspname} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  // node-postgres passes `options` to the server as start-up options.
  const databaseUrl = new URL(base.DATABASE_URL);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);

  const media = new FakeMedia();
  const transcription = new FakeTranscription();
  const language = new FakeLanguage();
  const search = new FakeSearch();
  const servers: FakeServer[] = await Promise.all([
    serve((r) => media.routes(r)),
    serve((r) => transcription.routes(r)),
    serve((r) => language.routes(r)),
    serve((r) => search.routes(r)),
  ]);

  const config: Config = {
    ...base,
    LIKHO_ENV: 'test',
    HTTP_PORT: 0,
    DATABASE_URL: databaseUrl.toString(),
    MEDIA_GRPC_ADDR: servers[0]!.address,
    TRANSCRIPTION_GRPC_ADDR: servers[1]!.address,
    LANGUAGE_GRPC_ADDR: servers[2]!.address,
    SEARCH_GRPC_ADDR: servers[3]!.address,
    CONSUMER_GROUP: schema,
    BOOTSTRAP_ADMIN_EMAIL: 'admin@example.test',
    BOOTSTRAP_ADMIN_PASSWORD: 'admin-password-1',
    BOOTSTRAP_ADMIN_NAME: 'Admin',
    BOOTSTRAP_WORKSPACE_NAME: 'Test workspace',
    ...overrides,
  };

  const nats = await connect({ servers: config.NATS_URL });
  const js = nats.jetstream();
  const seen: { subject: string; body: Record<string, any> }[] = [];
  const watcher = nats.subscribe('likho.>', {
    callback: (_error, message) => {
      try {
        seen.push({ subject: message.subject, body: JSON.parse(codec.decode(message.data)) });
      } catch {
        /* not JSON */
      }
    },
  });

  const app = await createApp(config);
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();

  return {
    app,
    url: url.replace('[::1]', '127.0.0.1'),
    config,
    media,
    transcription,
    language,
    search,
    nats,
    js,
    async publish(subject, type, data, id = newId('evt')) {
      const body = {
        specversion: '1.0',
        id,
        source: subject.startsWith('likho.media')
          ? 'likho-media'
          : subject.startsWith('likho.import')
            ? 'likho-connector-ameyo'
            : 'likho-transcription',
        type,
        time: new Date().toISOString(),
        subject: String(data.recording_id ?? ''),
        datacontenttype: 'application/json',
        data,
      };
      await js.publish(subject, codec.encode(JSON.stringify(body)), { msgID: id });
      return id;
    },
    published(subject) {
      return seen.filter((s) => s.subject === subject).map((s) => s.body);
    },
    async stop() {
      await app.close();
      watcher.unsubscribe();
      const manager = await nats.jetstreamManager();
      for (const stream of ['LIKHO', 'LIKHO_LIVE']) {
        for await (const consumer of manager.consumers.list(stream)) {
          if (consumer.name.startsWith(schema)) await manager.consumers.delete(stream, consumer.name);
        }
      }
      await nats.close();
      await Promise.all(servers.map((s) => s.close()));
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/** A GraphQL client that keeps the session cookie, like a browser. */
export class Browser {
  cookie = '';
  constructor(private readonly url: string) {}

  async graphql<T = any>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<{ data: T; errors?: { message: string; extensions?: { code?: string } }[] }> {
    const response = await fetch(`${this.url}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify({ query, variables }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    return (await response.json()) as {
      data: T;
      errors?: { message: string; extensions?: { code?: string } }[];
    };
  }

  /** Runs a query that must succeed and returns its data. */
  async ok<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const result = await this.graphql<T>(query, variables);
    if (result.errors?.length)
      throw new Error(
        `GraphQL: ${result.errors.map((e) => `${e.extensions?.code ?? '?'}: ${e.message}`).join('; ')}`,
      );
    return result.data;
  }

  /** Runs a query that must fail and returns the first error's code. */
  async fails(query: string, variables: Record<string, unknown> = {}): Promise<string> {
    const result = await this.graphql(query, variables);
    if (!result.errors?.length) throw new Error('expected an error, got data ' + JSON.stringify(result.data));
    return result.errors[0]!.extensions?.code ?? 'none';
  }

  async login(email: string, password: string) {
    return this.ok(
      `mutation ($email: String!, $password: String!) { login(email: $email, password: $password) { id email name role workspace { id name } } }`,
      { email, password },
    );
  }
}

/** Waits until `check` returns something truthy. */
export async function until<T>(check: () => Promise<T>, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Reads server-sent events from a path until `enough` says so. Returns the events seen. */
export async function readEvents(
  url: string,
  path: string,
  cookie: string,
  enough: (events: { type: string; data: any }[]) => boolean,
  timeoutMs = 10_000,
) {
  const controller = new AbortController();
  const response = await fetch(url + path, {
    headers: { cookie, accept: 'text/event-stream' },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) throw new Error(`SSE ${path}: ${response.status}`);
  const events: { type: string; data: any }[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        let type = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) events.push({ type, data: JSON.parse(data) });
      }
      if (enough(events)) break;
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}
