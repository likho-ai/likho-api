/** Insights as the web app reads them, mapped from likho.insights.v1. */
import { Field, Float, Int, ObjectType } from '@nestjs/graphql';
import type { Insights as InsightsPb } from '@likho-ai/contracts/insights/v1/insights_pb';

@ObjectType({ description: 'One yes/no observation of the auditor’s form, answered from the transcript.' })
export class InsightCheck {
  @Field() key: string;
  @Field() label: string;
  @Field({ description: 'yes, no, or na (the call gave no way to tell).' }) answer: string;
  @Field({ description: 'The line the answer rests on, quoted from the transcript; empty when none.' })
  evidence: string;
}

@ObjectType({ description: 'One scored point of the auditor’s form.' })
export class InsightScore {
  @Field() key: string;
  @Field() label: string;
  @Field(() => Float) score: number;
  @Field(() => Float) max: number;
  @Field({ description: 'Why, in one sentence.' }) reason: string;
}

@ObjectType({
  description:
    'What a language model says about a transcribed call: a summary, the products, the customer’s mood, and the auditor’s form pre-filled.',
})
export class Insights {
  @Field() id: string;
  @Field() transcriptId: string;
  @Field() recordingId: string;
  @Field(() => Int, { description: 'The transcript version the insights were made from.' })
  transcriptVersion: number;
  @Field({ description: 'A few sentences: who called about what, what was said, how it ended.' })
  summary: string;
  @Field({ description: 'What the customer wanted, in a few words.' }) intent: string;
  @Field(() => [String], { description: 'The products or services mentioned, as they were said.' })
  products: string[];
  @Field({ description: 'The customer’s mood by the end: positive, neutral, negative or mixed.' })
  sentiment: string;
  @Field(() => [InsightCheck]) checks: InsightCheck[];
  @Field(() => [InsightScore]) scores: InsightScore[];
  @Field(() => Float) scoreTotal: number;
  @Field(() => Float) scoreMax: number;
  @Field({ description: 'The model that answered, e.g. anthropic/claude-sonnet-5-5.' }) model: string;
  @Field(() => Int) inputTokens: number;
  @Field(() => Int) outputTokens: number;
  @Field({ description: 'The version of the auditor’s form the checks and scores follow.' })
  formVersion: string;
  @Field(() => Date, { nullable: true }) createdAt: Date | null;
}

@ObjectType({ description: 'Whether insights are made at all, and by which model.' })
export class InsightsStatus {
  @Field({
    description: 'False: no model is configured, so nothing is analysed and no transcript text leaves.',
  })
  enabled: boolean;
  @Field({ description: 'The model’s name, empty when none is configured.' }) model: string;
  @Field({ description: 'The version of the auditor’s form in use.' }) formVersion: string;
}

export function insightsFromPb(i: InsightsPb): Insights {
  return {
    id: i.id,
    transcriptId: i.transcriptId,
    recordingId: i.recordingId,
    transcriptVersion: i.transcriptVersion,
    summary: i.summary,
    intent: i.intent,
    products: [...i.products],
    sentiment: i.sentiment,
    checks: i.checks.map((c) => ({ key: c.key, label: c.label, answer: c.answer, evidence: c.evidence })),
    scores: i.scores.map((s) => ({
      key: s.key,
      label: s.label,
      score: s.score,
      max: s.max,
      reason: s.reason,
    })),
    scoreTotal: i.scoreTotal,
    scoreMax: i.scoreMax,
    model: i.model,
    inputTokens: i.inputTokens,
    outputTokens: i.outputTokens,
    formVersion: i.formVersion,
    createdAt: i.createdAt ? new Date(Number(i.createdAt.seconds) * 1000) : null,
  };
}

/** The insights as REST answers them. */
export function insightsJson(i: Insights) {
  return { ...i, createdAt: i.createdAt?.toISOString() ?? null };
}
