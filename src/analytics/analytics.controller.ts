/** The numbers behind the calls over REST, for scripts and the company's own dashboards. */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { AnalyticsBucketEnum, AnalyticsDimensionEnum, AnalyticsMetricEnum } from './analytics.graphql.js';
import type { AnalyticsBucket, AnalyticsDimension, AnalyticsMetric } from './analytics.graphql.js';
import { AnalyticsService, checkWindow } from './analytics.service.js';

class WindowQuery {
  @ApiProperty({ description: 'The start of the window of call time (ISO 8601), included.' })
  @IsISO8601()
  since: string;

  @ApiProperty({ description: 'The end of the window (ISO 8601), not included.' })
  @IsISO8601()
  until: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() campaign?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() agent?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() disposition?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() source?: string;
  @ApiProperty({ required: false, description: 'The language detected (ISO 639-1).' })
  @IsOptional()
  @IsString()
  language?: string;
}

class TimeseriesQuery extends WindowQuery {
  @ApiProperty({ enum: Object.keys(AnalyticsMetricEnum) })
  @IsIn(Object.keys(AnalyticsMetricEnum))
  metric: AnalyticsMetric;

  @ApiProperty({ required: false, enum: Object.keys(AnalyticsBucketEnum), default: 'day' })
  @IsOptional()
  @IsIn(Object.keys(AnalyticsBucketEnum))
  bucket?: AnalyticsBucket;
}

class BreakdownQuery extends WindowQuery {
  @ApiProperty({ enum: Object.keys(AnalyticsDimensionEnum) })
  @IsIn(Object.keys(AnalyticsDimensionEnum))
  by: AnalyticsDimension;

  @ApiProperty({
    required: false,
    description: 'At most this many rows, most calls first (default 50, at most 500).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

const facts = (q: WindowQuery) => ({
  campaign: q.campaign,
  agent: q.agent,
  disposition: q.disposition,
  source: q.source,
  language: q.language,
});

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('api/v1/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @ApiOperation({
    summary: 'What happened in a window',
    description: 'Calls, transcribed, failed, minutes, speed, analysed, score, and the moods and languages.',
  })
  overview(@CurrentUser() me: Principal, @Query() q: WindowQuery) {
    return this.analytics.overview(
      me.workspaceId,
      checkWindow(new Date(q.since), new Date(q.until)),
      facts(q),
    );
  }

  @Get('timeseries')
  @ApiOperation({ summary: 'One metric per day or hour across a window' })
  async timeseries(@CurrentUser() me: Principal, @Query() q: TimeseriesQuery) {
    const points = await this.analytics.timeseries(
      me.workspaceId,
      q.metric,
      q.bucket ?? 'day',
      checkWindow(new Date(q.since), new Date(q.until)),
      facts(q),
    );
    return { points: points.map((p) => ({ at: p.at.toISOString(), value: p.value })) };
  }

  @Get('breakdown')
  @ApiOperation({
    summary: 'A window’s calls by agent, campaign, disposition, language, sentiment or source',
  })
  async breakdown(@CurrentUser() me: Principal, @Query() q: BreakdownQuery) {
    const rows = await this.analytics.breakdown(
      me.workspaceId,
      q.by,
      checkWindow(new Date(q.since), new Date(q.until)),
      facts(q),
      q.limit,
    );
    return { rows };
  }
}
