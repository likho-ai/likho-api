/** Transcripts as the web app reads them, mapped from likho.transcription.v1. */
import { Field, Float, Int, ObjectType } from '@nestjs/graphql';
import type { Transcript as TranscriptPb } from '@likho-ai/contracts/transcription/v1/transcription_pb';
import { Script } from '@likho-ai/contracts/common/v1/common_pb';

@ObjectType()
export class Segment {
  @Field(() => Int) index: number;
  @Field(() => Float) startSeconds: number;
  @Field(() => Float) endSeconds: number;
  @Field({ description: 'Layer 1: as spoken, in the script of the language.' }) textScript: string;
  @Field({ description: 'Layer 2: Hinglish.' }) textRoman: string;
}

@ObjectType()
export class LanguageCandidate {
  @Field() language: string;
  @Field(() => Float) probability: number;
}

@ObjectType()
export class LanguageDetection {
  @Field() detected: string;
  @Field(() => Float) probability: number;
  @Field(() => [LanguageCandidate]) candidates: LanguageCandidate[];
  @Field() decodedAs: string;
  @Field() policy: string;
}

@ObjectType()
export class TranscriptStats {
  @Field(() => Float) audioSeconds: number;
  @Field(() => Float) elapsedSeconds: number;
  @Field(() => Float) realtimeFactor: number;
  @Field(() => Int) chunks: number;
  @Field(() => Float) silenceSkippedSeconds: number;
}

@ObjectType()
export class Transcript {
  @Field() id: string;
  @Field() recordingId: string;
  @Field() jobId: string;
  @Field(() => Int) version: number;
  @Field() modelRegistryId: string;
  @Field() engine: string;
  @Field() compute: string;
  @Field(() => LanguageDetection) language: LanguageDetection;
  @Field() script: string;
  @Field(() => [Segment]) segments: Segment[];
  @Field(() => TranscriptStats) stats: TranscriptStats;
  @Field(() => Date, { nullable: true }) createdAt: Date | null;
}

const SCRIPTS: Record<number, string> = {
  [Script.DEVANAGARI]: 'devanagari',
  [Script.LATIN]: 'latin',
  [Script.ARABIC]: 'arabic',
};

export function transcriptFromPb(t: TranscriptPb): Transcript {
  return {
    id: t.id,
    recordingId: t.recordingId,
    jobId: t.jobId,
    version: t.version,
    modelRegistryId: t.model?.registryId ?? '',
    engine: t.model?.engine ?? '',
    compute: t.model?.compute ?? '',
    language: {
      detected: t.language?.detected ?? '',
      probability: t.language?.probability ?? 0,
      candidates: (t.language?.candidates ?? []).map((c) => ({
        language: c.language,
        probability: c.probability,
      })),
      decodedAs: t.language?.decodedAs ?? '',
      policy: t.language?.policy ?? '',
    },
    script: SCRIPTS[t.script] ?? 'unspecified',
    segments: t.segments.map((s) => ({
      index: s.index,
      startSeconds: s.startSeconds,
      endSeconds: s.endSeconds,
      textScript: s.textScript,
      textRoman: s.textRoman,
    })),
    stats: {
      audioSeconds: t.stats?.audioSeconds ?? 0,
      elapsedSeconds: t.stats?.elapsedSeconds ?? 0,
      realtimeFactor: t.stats?.realtimeFactor ?? 0,
      chunks: t.stats?.chunks ?? 0,
      silenceSkippedSeconds: t.stats?.silenceSkippedSeconds ?? 0,
    },
    createdAt: t.createdAt ? new Date(Number(t.createdAt.seconds) * 1000) : null,
  };
}
