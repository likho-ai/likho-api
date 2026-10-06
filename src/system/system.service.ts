/**
 * Whether every service answers: one small call each, with a short deadline. A refusal that
 * proves the service is there (not found, invalid argument) counts as an answer.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Code, ConnectError } from '@connectrpc/connect';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Clients } from '../clients/clients.module.js';
import { CONFIG, type Config } from '../config/config.js';
import { VERSION } from '../version.js';
import type { ServiceStatus, SystemStatus } from './system.graphql.js';

const DEADLINE_MS = 3000;
const ALIVE = new Set([Code.NotFound, Code.InvalidArgument, Code.FailedPrecondition, Code.PermissionDenied]);

@Injectable()
export class SystemService {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly clients: Clients,
  ) {}

  async status(workspaceId: string): Promise<SystemStatus> {
    const options = { timeoutMs: DEADLINE_MS };
    const now = new Date();
    const probes: [string, string, () => Promise<string>][] = [
      [
        'likho-media',
        this.config.MEDIA_GRPC_ADDR,
        async () => (await this.clients.media.getMedia({ id: 'med_probe' }, options), 'answers'),
      ],
      [
        'likho-transcription',
        this.config.TRANSCRIPTION_GRPC_ADDR,
        async () => {
          const reply = await this.clients.transcription.listEngines({}, options);
          return `${reply.engines.length} engine${reply.engines.length === 1 ? '' : 's'}`;
        },
      ],
      [
        'likho-language',
        this.config.LANGUAGE_GRPC_ADDR,
        async () => (
          await this.clients.language.getHotwords({ workspaceId, language: 'hi' }, options),
          'answers'
        ),
      ],
      [
        'likho-search',
        this.config.SEARCH_GRPC_ADDR,
        async () => (await this.clients.search.search({ workspaceId, query: 'likho' }, options), 'answers'),
      ],
      [
        'likho-insights',
        this.config.INSIGHTS_GRPC_ADDR,
        async () => {
          const reply = await this.clients.insights.getStatus({}, options);
          return reply.enabled ? `model ${reply.model}` : 'no model configured';
        },
      ],
      [
        'likho-analytics',
        this.config.ANALYTICS_GRPC_ADDR,
        async () => {
          await this.clients.analytics.getOverview(
            {
              workspaceId,
              window: {
                since: timestampFromDate(new Date(now.getTime() - 3_600_000)),
                until: timestampFromDate(now),
              },
            },
            options,
          );
          return 'answers';
        },
      ],
      [
        'likho-connector-ameyo',
        this.config.DIALER_GRPC_ADDR,
        async () => {
          const reply = await this.clients.dialer.getStatus({}, options);
          return `${reply.version}; schedule ${reply.scheduleEnabled ? 'on' : 'off'}; ${reply.importedToday} of ${reply.dailyLimit} today`;
        },
      ],
    ];
    const services = await Promise.all(
      probes.map(([name, address, probe]): Promise<ServiceStatus> => this.probe(name, address, probe)),
    );
    return { version: VERSION, checkedAt: now, services };
  }

  private async probe(name: string, address: string, probe: () => Promise<string>): Promise<ServiceStatus> {
    const started = Date.now();
    try {
      const detail = await probe();
      return { name, address, ok: true, detail, latencyMs: Date.now() - started };
    } catch (error) {
      const latencyMs = Date.now() - started;
      if (error instanceof ConnectError && ALIVE.has(error.code)) {
        return { name, address, ok: true, detail: 'answers', latencyMs };
      }
      const detail =
        error instanceof ConnectError
          ? error.code === Code.DeadlineExceeded
            ? `no answer within ${DEADLINE_MS / 1000} s`
            : error.rawMessage || Code[error.code]
          : error instanceof Error
            ? error.message
            : 'not reachable';
      return { name, address, ok: false, detail, latencyMs };
    }
  }
}
