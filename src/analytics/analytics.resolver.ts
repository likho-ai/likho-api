import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import {
  AnalyticsBucketEnum,
  AnalyticsDimensionEnum,
  AnalyticsFacts,
  AnalyticsMetricEnum,
  AnalyticsOverview,
  AnalyticsPoint,
  AnalyticsRow,
} from './analytics.graphql.js';
import type { AnalyticsBucket, AnalyticsDimension, AnalyticsMetric } from './analytics.graphql.js';
import { AnalyticsService, checkWindow } from './analytics.service.js';

@Resolver()
export class AnalyticsResolver {
  constructor(private readonly service: AnalyticsService) {}

  @Query(() => AnalyticsOverview, {
    description:
      'What happened to the calls made between since (included) and until (not): how many, transcribed, minutes, speed, analysed, score, moods and languages.',
  })
  async analyticsOverview(
    @CurrentUser() me: Principal,
    @Args('since', { type: () => Date }) since: Date,
    @Args('until', { type: () => Date }) until: Date,
    @Args('facts', { nullable: true }) facts?: AnalyticsFacts,
  ): Promise<AnalyticsOverview> {
    return this.service.overview(me.workspaceId, checkWindow(since, until), facts);
  }

  @Query(() => [AnalyticsPoint], {
    description: 'One metric per day (or hour) across the window, empty buckets at 0; a chart.',
  })
  async analyticsTimeseries(
    @CurrentUser() me: Principal,
    @Args('metric', { type: () => AnalyticsMetricEnum }) metric: AnalyticsMetric,
    @Args('since', { type: () => Date }) since: Date,
    @Args('until', { type: () => Date }) until: Date,
    @Args('bucket', { type: () => AnalyticsBucketEnum, nullable: true }) bucket?: AnalyticsBucket,
    @Args('facts', { nullable: true }) facts?: AnalyticsFacts,
  ): Promise<AnalyticsPoint[]> {
    return this.service.timeseries(me.workspaceId, metric, bucket ?? 'day', checkWindow(since, until), facts);
  }

  @Query(() => [AnalyticsRow], {
    description:
      'The window’s calls split by agent, campaign, disposition, language, sentiment or source, most calls first.',
  })
  async analyticsBreakdown(
    @CurrentUser() me: Principal,
    @Args('by', { type: () => AnalyticsDimensionEnum }) by: AnalyticsDimension,
    @Args('since', { type: () => Date }) since: Date,
    @Args('until', { type: () => Date }) until: Date,
    @Args('facts', { nullable: true }) facts?: AnalyticsFacts,
    @Args('limit', { type: () => Int, nullable: true }) limit?: number,
  ): Promise<AnalyticsRow[]> {
    return this.service.breakdown(me.workspaceId, by, checkWindow(since, until), facts, limit ?? undefined);
  }
}
