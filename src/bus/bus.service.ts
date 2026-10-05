/**
 * The event bus: NATS JetStream. Events are CloudEvents 1.0 as JSON (likho-contracts/events).
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  AckPolicy,
  connect,
  DeliverPolicy,
  JetStreamClient,
  JetStreamManager,
  JsMsg,
  NatsConnection,
  StringCodec,
} from 'nats';
import { newId } from '../common/ids.js';
import { CONFIG, type Config } from '../config/config.js';
import { MetricsService } from '../metrics/metrics.service.js';

export const SOURCE = 'likho-api';
const codec = StringCodec();

export interface CloudEvent<T = Record<string, unknown>> {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  time: string;
  subject: string;
  datacontenttype: 'application/json';
  data: T;
}

export function event<T extends Record<string, unknown>>(
  type: string,
  subject: string,
  data: T,
): CloudEvent<T> {
  return {
    specversion: '1.0',
    id: newId('evt'),
    source: SOURCE,
    type,
    time: new Date().toISOString(),
    subject,
    datacontenttype: 'application/json',
    data,
  };
}

export type Handler = (event: CloudEvent, message: JsMsg) => Promise<void>;

interface Consumer {
  stop: () => void;
  done: Promise<void>;
}

@Injectable()
export class BusService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('bus');
  private connection: NatsConnection | null = null;
  private jetstream: JetStreamClient | null = null;
  private manager: JetStreamManager | null = null;
  private readonly consumers: Consumer[] = [];

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Connects, trying again while NATS is not there yet (it may be starting at the same time),
   * for NATS_CONNECT_TIMEOUT_SECONDS; once connected, the client reconnects on its own.
   */
  async onModuleInit(): Promise<void> {
    const deadline = Date.now() + this.config.NATS_CONNECT_TIMEOUT_SECONDS * 1000;
    let wait = 1000;
    for (;;) {
      try {
        await this.open();
        this.log.log(`connected to ${this.config.NATS_URL}`);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.connection?.close().catch(() => undefined);
        this.connection = null;
        if (Date.now() + wait > deadline) {
          throw new Error(`the event bus at ${this.config.NATS_URL} did not answer in time: ${reason}`);
        }
        this.log.warn(`event bus not ready (${reason}); trying again in ${wait / 1000} s`);
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = Math.min(wait * 2, 10_000);
      }
    }
  }

  private async open(): Promise<void> {
    this.connection = await connect({
      servers: this.config.NATS_URL,
      name: SOURCE,
      maxReconnectAttempts: -1,
      timeout: 5_000,
    });
    this.jetstream = this.connection.jetstream();
    this.manager = await this.connection.jetstreamManager();
    try {
      await this.manager.streams.info('LIKHO');
    } catch {
      throw new Error(`stream LIKHO does not exist; create the streams first (likho-infra: scripts/up.sh)`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const consumer of this.consumers) consumer.stop();
    await Promise.all(this.consumers.map((consumer) => consumer.done));
    await this.connection?.close();
  }

  get connected(): boolean {
    return this.connection !== null && !this.connection.isClosed();
  }

  /** Stores the event in its stream; returns when the server has confirmed it. */
  async publish(subject: string, body: CloudEvent): Promise<void> {
    if (!this.jetstream) throw new Error('the bus is not connected');
    await this.jetstream.publish(subject, codec.encode(JSON.stringify(body)), {
      msgID: body.id,
      timeout: 5_000,
    });
  }

  /**
   * Takes events from a subject through a durable pull consumer shared by every instance with
   * the same name. The handler acknowledges by returning; a thrown error means try again later;
   * a message that is not a CloudEvent is dropped.
   */
  async consume(options: {
    stream: 'LIKHO' | 'LIKHO_LIVE';
    durable: string;
    subject: string;
    /** 'all': also events published while nobody listened. 'new': only from now on. Default: CONSUMER_START. */
    from?: 'all' | 'new';
    handler: Handler;
  }): Promise<void> {
    if (!this.manager || !this.jetstream) throw new Error('the bus is not connected');
    const durable = `${this.config.CONSUMER_GROUP}-${options.durable}`;
    await this.manager.consumers.add(options.stream, {
      durable_name: durable,
      ack_policy: AckPolicy.Explicit,
      ack_wait: 30_000_000_000, // 30 s, in nanoseconds
      max_deliver: 5,
      deliver_policy:
        (options.from ?? this.config.CONSUMER_START) === 'new' ? DeliverPolicy.New : DeliverPolicy.All,
      filter_subject: options.subject,
    });
    const consumer = await this.jetstream.consumers.get(options.stream, durable);
    const messages = await consumer.consume({ max_messages: 10 });

    const done = (async () => {
      for await (const message of messages) {
        await this.handle(message, options.handler);
      }
    })();
    this.consumers.push({ stop: () => messages.stop(), done });
    this.log.log(`taking ${options.subject} as ${durable}`);
  }

  private async handle(message: JsMsg, handler: Handler): Promise<void> {
    let parsed: CloudEvent;
    try {
      parsed = JSON.parse(codec.decode(message.data)) as CloudEvent;
      if (!parsed?.type || !parsed.id || typeof parsed.data !== 'object') throw new Error('not a CloudEvent');
    } catch (error) {
      this.log.error(`dropping a message on ${message.subject} that is not an event: ${String(error)}`);
      message.term();
      this.metrics.eventsHandled.add(1, { subject: message.subject, outcome: 'dropped' });
      return;
    }
    try {
      await handler(parsed, message);
      message.ack();
      this.metrics.eventsHandled.add(1, { subject: message.subject, outcome: 'ok' });
    } catch (error) {
      const attempt = message.info.redeliveryCount;
      this.log.warn(`${parsed.type} ${parsed.id} attempt ${attempt} failed: ${String(error)}`);
      if (attempt >= 5) {
        message.term();
        this.metrics.eventsHandled.add(1, { subject: message.subject, outcome: 'dropped' });
      } else {
        message.nak(Math.min(attempt, 5) * 5_000);
        this.metrics.eventsHandled.add(1, { subject: message.subject, outcome: 'retry' });
      }
    }
  }
}
