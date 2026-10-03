/**
 * Live updates for browsers: each line as it is transcribed, and job and recording changes.
 *
 * Updates travel through Redis pub/sub, so a browser connected to one instance sees what
 * another instance learned from the bus. The last lines of a running job are kept for a short
 * while, so a page that opens late catches up.
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import { Observable } from 'rxjs';
import { CONFIG, type Config } from '../config/config.js';

export interface LiveUpdate {
  /** 'segment' (a transcribed line), 'job' (status or progress), 'recording' (status). */
  kind: 'segment' | 'job' | 'recording' | 'import';
  jobId?: string;
  recordingId: string;
  /** For updates that are not about one recording yet (an import): whose they are. */
  workspaceId?: string;
  data: Record<string, unknown>;
}

const CHANNEL = 'likho:live';
const TAIL_SECONDS = 3600;
const TAIL_LINES = 500;

@Injectable()
export class LiveService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('live');
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Set<(update: LiveUpdate) => void>();

  constructor(@Inject(CONFIG) config: Config) {
    this.redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.subscriber = new Redis(config.REDIS_URL, { lazyConnect: true });
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect();
    await this.subscriber.connect();
    await this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (_channel: string, raw: string) => {
      try {
        const update = JSON.parse(raw) as LiveUpdate;
        for (const listener of this.listeners) listener(update);
      } catch (error) {
        this.log.warn(`ignored a live update that is not JSON: ${String(error)}`);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriber.disconnect();
    this.redis.disconnect();
  }

  async ping(): Promise<boolean> {
    return (await this.redis.ping()) === 'PONG';
  }

  /** Sends an update to every browser watching, on every instance. */
  async publish(update: LiveUpdate): Promise<void> {
    const raw = JSON.stringify(update);
    if (update.kind === 'segment' && update.jobId) {
      const key = `likho:job:${update.jobId}:tail`;
      await this.redis.multi().rpush(key, raw).ltrim(key, -TAIL_LINES, -1).expire(key, TAIL_SECONDS).exec();
    }
    await this.redis.publish(CHANNEL, raw);
  }

  /** The lines a running job has produced so far. */
  async tail(jobId: string): Promise<LiveUpdate[]> {
    const raw = await this.redis.lrange(`likho:job:${jobId}:tail`, 0, -1);
    return raw.map((item) => JSON.parse(item) as LiveUpdate);
  }

  /** Updates about one job (its lines and status), or everything in a workspace's recordings. */
  watch(filter: (update: LiveUpdate) => boolean): Observable<LiveUpdate> {
    return new Observable<LiveUpdate>((observer) => {
      const listener = (update: LiveUpdate) => {
        if (filter(update)) observer.next(update);
      };
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    });
  }
}
