/**
 * Metrics (OpenTelemetry): always served as Prometheus text at GET /metrics, and pushed over
 * OTLP/HTTP as well when OTEL_EXPORTER_OTLP_ENDPOINT is set (the likho-infra `obs` profile, or a
 * collector). What they say: jobs by state, how old the oldest waiting job is, jobs finished by
 * outcome, how fast transcription runs against real time, events handled, sweeps.
 */
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Counter, Histogram, Meter } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, type MetricReader } from '@opentelemetry/sdk-metrics';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONFIG, type Config } from '../config/config.js';
import { VERSION } from '../version.js';

export type JobCounts = Record<string, number>;

@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly log = new Logger('metrics');
  private readonly provider: MeterProvider;
  private readonly prometheus: PrometheusExporter;
  readonly meter: Meter;

  /** Jobs that ended, by outcome: done, failed, cancelled. */
  readonly jobsFinished: Counter;
  /** Audio seconds transcribed per wall-clock second of the job (1 = real time, 2 = twice as fast). */
  readonly realtimeFactor: Histogram;
  /** Events taken from the bus, by subject and what became of them: ok, retry, dropped. */
  readonly eventsHandled: Counter;
  /** What the job sweeper did: requeued, failed. */
  readonly sweeps: Counter;

  private jobCounts: () => Promise<JobCounts> = async () => ({});
  private oldestQueued: () => Promise<number> = async () => 0;

  constructor(@Inject(CONFIG) config: Config) {
    this.prometheus = new PrometheusExporter({ preventServerStart: true });
    const readers: MetricReader[] = [this.prometheus];
    if (config.OTEL_EXPORTER_OTLP_ENDPOINT) {
      const url = config.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '') + '/v1/metrics';
      readers.push(
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url }),
          exportIntervalMillis: 15_000,
        }),
      );
      this.log.log(`metrics go to ${url} every 15 s, and are at /metrics`);
    }
    this.provider = new MeterProvider({
      resource: resourceFromAttributes({ 'service.name': 'likho-api', 'service.version': VERSION }),
      readers,
    });
    this.meter = this.provider.getMeter('likho-api', VERSION);

    this.jobsFinished = this.meter.createCounter('likho_jobs_finished', {
      description: 'Jobs that ended, by outcome',
    });
    this.realtimeFactor = this.meter.createHistogram('likho_job_realtime_factor', {
      description: 'Audio seconds transcribed per second of wall-clock time',
      advice: { explicitBucketBoundaries: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10] },
    });
    this.eventsHandled = this.meter.createCounter('likho_events_handled', {
      description: 'Events taken from the bus, by subject and outcome',
    });
    this.sweeps = this.meter.createCounter('likho_job_sweeps', {
      description: 'What the job sweeper did to stuck or stalled jobs',
    });
    // The known label sets start at 0, so Prometheus sees the first real increment as an
    // increase; a counter born at 1 shows no rate until the second one.
    for (const status of ['done', 'failed', 'cancelled']) this.jobsFinished.add(0, { status });
    for (const outcome of ['requeued', 'failed']) this.sweeps.add(0, { outcome });
    this.meter
      .createObservableGauge('likho_jobs', { description: 'Jobs by status' })
      .addCallback(async (result) => {
        for (const [status, count] of Object.entries(await this.jobCounts()))
          result.observe(count, { status });
      });
    this.meter
      .createObservableGauge('likho_jobs_queue_oldest_seconds', {
        description: 'How long the oldest waiting job has been waiting',
      })
      .addCallback(async (result) => result.observe(await this.oldestQueued()));
  }

  /** Who answers the job gauges (the recordings service, once it exists). */
  observeJobs(counts: () => Promise<JobCounts>, oldestQueuedSeconds: () => Promise<number>): void {
    this.jobCounts = counts;
    this.oldestQueued = oldestQueuedSeconds;
  }

  /** Serves the Prometheus text. */
  scrape(request: IncomingMessage, response: ServerResponse): void {
    this.prometheus.getMetricsRequestHandler(request, response);
  }

  async onModuleDestroy(): Promise<void> {
    await this.provider.shutdown().catch(() => undefined);
  }
}
