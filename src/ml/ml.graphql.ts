/** Speech models, the gold set and evaluations as the admin screen reads them (likho.ml.v1). */
import { Field, Float, InputType, Int, ObjectType } from '@nestjs/graphql';
import {
  EvaluationStatus,
  ModelStatus,
  type Evaluation as EvaluationPb,
  type GoldItem as GoldItemPb,
  type Model as ModelPb,
  type Scores as ScoresPb,
} from '@likho-ai/contracts/ml/v1/ml_pb';
import type { Timestamp } from '@bufbuild/protobuf/wkt';

const date = (t: Timestamp | undefined): Date | null =>
  t && t.seconds ? new Date(Number(t.seconds) * 1000) : null;

@ObjectType({
  description:
    'Error rates (0 = perfect): word and character, of the script layer and of the roman (Hinglish) layer, where spelling variants are forgiven.',
})
export class ErrorRates {
  @Field(() => Float) werScript: number;
  @Field(() => Float) cerScript: number;
  @Field(() => Float) werRoman: number;
  @Field(() => Float) cerRoman: number;
}

@ObjectType({ description: 'A speech model the transcription service can load.' })
export class SpeechModel {
  @Field() id: string;
  @Field({ description: '<engine>/<name>, e.g. faster-whisper/turbo.' }) registryId: string;
  @Field() engine: string;
  @Field() name: string;
  @Field() description: string;
  @Field(() => [String], { description: 'Languages it is meant for; empty = any.' }) languages: string[];
  @Field({ description: 'Where its weights are; empty for an engine’s own published sizes.' })
  artifactUri: string;
  @Field({ description: 'The model this one was fine-tuned from, if any.' }) baseModelId: string;
  @Field({ description: 'available or retired.' }) status: string;
  @Field({ description: 'True for the model new transcriptions use.' }) isDefault: boolean;
  @Field(() => ErrorRates, { nullable: true, description: 'Its newest completed evaluation, if any.' })
  latestScores: ErrorRates | null;
  @Field(() => String, { nullable: true }) latestEvaluationId: string | null;
  @Field(() => Date, { nullable: true }) createdAt: Date | null;
}

@ObjectType({ description: 'A recording of the gold set: its corrected transcript is the reference.' })
export class GoldItem {
  @Field() recordingId: string;
  @Field() transcriptId: string;
  @Field(() => Int) transcriptVersion: number;
  @Field() language: string;
  @Field(() => Float) audioSeconds: number;
  @Field(() => Int) lines: number;
  @Field() addedBy: string;
  @Field(() => Date, { nullable: true }) addedAt: Date | null;
}

@ObjectType({ description: 'The workspace’s gold set.' })
export class GoldSet {
  @Field(() => [GoldItem]) items: GoldItem[];
  @Field(() => Float) audioSeconds: number;
}

@ObjectType({ description: 'One gold recording of an evaluation, transcribed by the model and scored.' })
export class EvaluationItem {
  @Field() recordingId: string;
  @Field(() => ErrorRates) scores: ErrorRates;
  @Field(() => Int, { description: 'Reference words.' }) words: number;
  @Field(() => Float) audioSeconds: number;
  @Field({ description: 'Why this recording could not be scored; empty when it was.' }) error: string;
}

@ObjectType({ description: 'A model scored on the gold set.' })
export class Evaluation {
  @Field() id: string;
  @Field() modelId: string;
  @Field() registryId: string;
  @Field({ description: 'queued, running, completed or failed.' }) status: string;
  @Field(() => ErrorRates, { description: 'Over all recordings, weighted by their length.' })
  scores: ErrorRates;
  @Field(() => Int) itemsTotal: number;
  @Field(() => Int) itemsDone: number;
  @Field(() => Float) audioSeconds: number;
  @Field(() => Float, { description: 'Audio seconds transcribed per second of wall-clock time.' })
  realtimeFactor: number;
  @Field(() => [EvaluationItem]) items: EvaluationItem[];
  @Field() error: string;
  @Field() startedBy: string;
  @Field(() => Date, { nullable: true }) createdAt: Date | null;
  @Field(() => Date, { nullable: true }) finishedAt: Date | null;
}

@ObjectType({ description: 'What people’s corrections have given as training data so far.' })
export class TrainingStats {
  @Field(() => Int, { description: 'Corrected lines (the newest correction of each counts).' })
  examples: number;
  @Field(() => Int) scriptExamples: number;
  @Field(() => Int) romanExamples: number;
  @Field(() => Int) recordings: number;
  @Field(() => Float, { description: 'Audio the corrected lines cover.' }) audioSeconds: number;
  @Field(() => Date, { nullable: true }) lastExampleAt: Date | null;
}

@InputType()
export class RegisterSpeechModelInput {
  @Field({ description: '<engine>/<name>, e.g. faster-whisper/likho-2026-10.' }) registryId: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => [String], { nullable: true }) languages?: string[];
  @Field({ nullable: true, description: 's3://likho-models/... for a fine-tuned model.' })
  artifactUri?: string;
  @Field({ nullable: true }) baseModelId?: string;
}

const MODEL_STATUS: Record<number, string> = {
  [ModelStatus.AVAILABLE]: 'available',
  [ModelStatus.RETIRED]: 'retired',
};
const EVALUATION_STATUS: Record<number, string> = {
  [EvaluationStatus.QUEUED]: 'queued',
  [EvaluationStatus.RUNNING]: 'running',
  [EvaluationStatus.COMPLETED]: 'completed',
  [EvaluationStatus.FAILED]: 'failed',
};

const rates = (s: ScoresPb | undefined): ErrorRates => ({
  werScript: s?.werScript ?? 0,
  cerScript: s?.cerScript ?? 0,
  werRoman: s?.werRoman ?? 0,
  cerRoman: s?.cerRoman ?? 0,
});

export function modelFromPb(m: ModelPb): SpeechModel {
  return {
    id: m.id,
    registryId: m.registryId,
    engine: m.engine,
    name: m.name,
    description: m.description,
    languages: [...m.languages],
    artifactUri: m.artifactUri,
    baseModelId: m.baseModelId,
    status: MODEL_STATUS[m.status] ?? 'unknown',
    isDefault: m.isDefault,
    latestScores: m.latestEvaluationId ? rates(m.latestScores) : null,
    latestEvaluationId: m.latestEvaluationId || null,
    createdAt: date(m.createdAt),
  };
}

export function goldFromPb(g: GoldItemPb): GoldItem {
  return {
    recordingId: g.recordingId,
    transcriptId: g.transcriptId,
    transcriptVersion: g.transcriptVersion,
    language: g.language,
    audioSeconds: g.audioSeconds,
    lines: g.lines,
    addedBy: g.addedBy,
    addedAt: date(g.addedAt),
  };
}

export function evaluationFromPb(e: EvaluationPb): Evaluation {
  return {
    id: e.id,
    modelId: e.modelId,
    registryId: e.registryId,
    status: EVALUATION_STATUS[e.status] ?? 'unknown',
    scores: rates(e.scores),
    itemsTotal: e.itemsTotal,
    itemsDone: e.itemsDone,
    audioSeconds: e.audioSeconds,
    realtimeFactor: e.realtimeFactor,
    items: e.items.map((i) => ({
      recordingId: i.recordingId,
      scores: rates(i.scores),
      words: i.words,
      audioSeconds: i.audioSeconds,
      error: i.error,
    })),
    error: e.error,
    startedBy: e.startedBy,
    createdAt: date(e.createdAt),
    finishedAt: date(e.finishedAt),
  };
}

/** REST answers dates as ISO text. */
export function json<T extends object>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
