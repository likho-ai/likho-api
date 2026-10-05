/** The numbers behind the calls as the web app reads them, mapped from likho.analytics.v1. */
import { Field, Float, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import type {
  Count as CountPb,
  Overview as OverviewPb,
  Point as PointPb,
  Row as RowPb,
} from '@likho-ai/contracts/analytics/v1/analytics_pb';
import { Bucket, Dimension, Metric } from '@likho-ai/contracts/analytics/v1/analytics_pb';

export const AnalyticsMetricEnum = {
  calls: 'calls',
  transcribed: 'transcribed',
  minutes: 'minutes',
  realtimeFactor: 'realtimeFactor',
  analysed: 'analysed',
  score: 'score',
  negative: 'negative',
} as const;
registerEnumType(AnalyticsMetricEnum, {
  name: 'AnalyticsMetric',
  description:
    'calls that arrived; calls with a transcript; minutes of audio transcribed; seconds of work per second of audio; calls the model analysed; their mean score (0 to 1); analysed calls in a negative mood.',
});
export type AnalyticsMetric = keyof typeof AnalyticsMetricEnum;

export const AnalyticsBucketEnum = { day: 'day', hour: 'hour' } as const;
registerEnumType(AnalyticsBucketEnum, { name: 'AnalyticsBucket' });
export type AnalyticsBucket = keyof typeof AnalyticsBucketEnum;

export const AnalyticsDimensionEnum = {
  agent: 'agent',
  campaign: 'campaign',
  disposition: 'disposition',
  language: 'language',
  sentiment: 'sentiment',
  source: 'source',
} as const;
registerEnumType(AnalyticsDimensionEnum, { name: 'AnalyticsDimension' });
export type AnalyticsDimension = keyof typeof AnalyticsDimensionEnum;

export const METRICS: Record<AnalyticsMetric, Metric> = {
  calls: Metric.CALLS,
  transcribed: Metric.TRANSCRIBED,
  minutes: Metric.MINUTES,
  realtimeFactor: Metric.REALTIME_FACTOR,
  analysed: Metric.ANALYSED,
  score: Metric.SCORE,
  negative: Metric.NEGATIVE,
};
export const BUCKETS: Record<AnalyticsBucket, Bucket> = { day: Bucket.DAY, hour: Bucket.HOUR };
export const DIMENSIONS: Record<AnalyticsDimension, Dimension> = {
  agent: Dimension.AGENT,
  campaign: Dimension.CAMPAIGN,
  disposition: Dimension.DISPOSITION,
  language: Dimension.LANGUAGE,
  sentiment: Dimension.SENTIMENT,
  source: Dimension.SOURCE,
};

@InputType({ description: 'Narrows to calls with these facts; a field left out means any.' })
export class AnalyticsFacts {
  @Field({ nullable: true }) campaign?: string;
  @Field({ nullable: true }) agent?: string;
  @Field({ nullable: true }) disposition?: string;
  @Field({ nullable: true, description: 'upload, api, or a connector’s name.' }) source?: string;
  @Field({ nullable: true, description: 'The language detected (ISO 639-1).' }) language?: string;
}

@ObjectType()
export class AnalyticsCount {
  @Field() key: string;
  @Field(() => Int) count: number;
}

@ObjectType({ description: 'What happened in a window of call time.' })
export class AnalyticsOverview {
  @Field(() => Int, { description: 'Calls that arrived.' }) calls: number;
  @Field(() => Int, { description: 'Calls with a transcript.' }) transcribed: number;
  @Field(() => Int, { description: 'Calls whose transcription failed and was not redone.' }) failed: number;
  @Field(() => Float, { description: 'Minutes of audio transcribed.' }) minutes: number;
  @Field(() => Float, { description: 'Seconds of transcription per second of audio; lower is faster.' })
  realtimeFactor: number;
  @Field(() => Int, { description: 'Calls the model analysed.' }) analysed: number;
  @Field(() => Float, { description: 'The mean score of the analysed calls, 0 to 1; 0 when none.' })
  score: number;
  @Field(() => [AnalyticsCount], { description: 'Analysed calls by sentiment.' })
  sentiments: AnalyticsCount[];
  @Field(() => [AnalyticsCount], { description: 'Transcribed calls by detected language.' })
  languages: AnalyticsCount[];
}

@ObjectType({ description: 'One bucket of a timeseries.' })
export class AnalyticsPoint {
  @Field(() => Date, { description: 'The start of the bucket.' }) at: Date;
  @Field(() => Float) value: number;
}

@ObjectType({ description: 'One line of a breakdown.' })
export class AnalyticsRow {
  @Field({ description: 'The agent, campaign, …; "(none)" when the call had none.' }) key: string;
  @Field(() => Int) calls: number;
  @Field(() => Int) transcribed: number;
  @Field(() => Float) minutes: number;
  @Field(() => Int) analysed: number;
  @Field(() => Float, { description: 'The mean score of the analysed calls, 0 to 1; 0 when none.' })
  score: number;
  @Field(() => Int, { description: 'Analysed calls in a negative mood.' }) negative: number;
}

const counts = (items: CountPb[]): AnalyticsCount[] =>
  items.map((c) => ({ key: c.key, count: Number(c.count) }));

export function overviewFromPb(o: OverviewPb | undefined): AnalyticsOverview {
  return {
    calls: Number(o?.calls ?? 0),
    transcribed: Number(o?.transcribed ?? 0),
    failed: Number(o?.failed ?? 0),
    minutes: o?.minutes ?? 0,
    realtimeFactor: o?.realtimeFactor ?? 0,
    analysed: Number(o?.analysed ?? 0),
    score: o?.score ?? 0,
    sentiments: counts(o?.sentiments ?? []),
    languages: counts(o?.languages ?? []),
  };
}

export function pointFromPb(p: PointPb): AnalyticsPoint {
  return { at: p.at ? new Date(Number(p.at.seconds) * 1000) : new Date(0), value: p.value };
}

export function rowFromPb(r: RowPb): AnalyticsRow {
  return {
    key: r.key,
    calls: Number(r.calls),
    transcribed: Number(r.transcribed),
    minutes: r.minutes,
    analysed: Number(r.analysed),
    score: r.score,
    negative: Number(r.negative),
  };
}
