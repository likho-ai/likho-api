/** The numbers behind the calls, asked of likho-analytics for the workspace that owns them. */
import { Injectable } from '@nestjs/common';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { invalid } from '../common/errors.js';
import {
  AnalyticsBucket,
  AnalyticsDimension,
  AnalyticsFacts,
  AnalyticsMetric,
  AnalyticsOverview,
  AnalyticsPoint,
  AnalyticsRow,
  BUCKETS,
  DIMENSIONS,
  METRICS,
  overviewFromPb,
  pointFromPb,
  rowFromPb,
} from './analytics.graphql.js';

export interface Window {
  since: Date;
  until: Date;
}

const MAX_DAYS = 400;

@Injectable()
export class AnalyticsService {
  constructor(private readonly clients: Clients) {}

  async overview(workspaceId: string, window: Window, facts?: AnalyticsFacts): Promise<AnalyticsOverview> {
    try {
      const reply = await this.clients.analytics.getOverview({
        workspaceId,
        window: windowPb(window),
        facts: factsPb(facts),
      });
      return overviewFromPb(reply.overview);
    } catch (error) {
      throw fromRpc(error, 'analytics');
    }
  }

  async timeseries(
    workspaceId: string,
    metric: AnalyticsMetric,
    bucket: AnalyticsBucket,
    window: Window,
    facts?: AnalyticsFacts,
  ): Promise<AnalyticsPoint[]> {
    try {
      const reply = await this.clients.analytics.getTimeseries({
        workspaceId,
        window: windowPb(window),
        facts: factsPb(facts),
        metric: METRICS[metric],
        bucket: BUCKETS[bucket],
      });
      return reply.points.map(pointFromPb);
    } catch (error) {
      throw fromRpc(error, 'analytics');
    }
  }

  async breakdown(
    workspaceId: string,
    by: AnalyticsDimension,
    window: Window,
    facts?: AnalyticsFacts,
    limit?: number,
  ): Promise<AnalyticsRow[]> {
    try {
      const reply = await this.clients.analytics.getBreakdown({
        workspaceId,
        window: windowPb(window),
        facts: factsPb(facts),
        by: DIMENSIONS[by],
        limit: limit ?? 0,
      });
      return reply.rows.map(rowFromPb);
    } catch (error) {
      throw fromRpc(error, 'analytics');
    }
  }
}

/** A window as the service wants it; what is wrong with it is said here, not by the service. */
export function checkWindow(since: Date, until: Date): Window {
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()))
    throw invalid('since and until must be dates.');
  if (until <= since) throw invalid('until must come after since.');
  if (until.getTime() - since.getTime() > MAX_DAYS * 86_400_000)
    throw invalid(`A window spans at most ${MAX_DAYS} days.`);
  return { since, until };
}

function windowPb(window: Window) {
  return { since: timestampFromDate(window.since), until: timestampFromDate(window.until) };
}

function factsPb(facts?: AnalyticsFacts) {
  return {
    campaign: facts?.campaign ?? '',
    agent: facts?.agent ?? '',
    disposition: facts?.disposition ?? '',
    source: facts?.source ?? '',
    language: facts?.language ?? '',
  };
}
