/** The GraphQL shapes of recordings and jobs. */
import { Field, Float, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { JOB_STATUSES, RECORDING_STATUSES } from '../db/schema.js';

export const RecordingStatusEnum = Object.fromEntries(RECORDING_STATUSES.map((s) => [s, s])) as Record<
  (typeof RECORDING_STATUSES)[number],
  (typeof RECORDING_STATUSES)[number]
>;
registerEnumType(RecordingStatusEnum, { name: 'RecordingStatus' });

export const JobStatusEnum = Object.fromEntries(JOB_STATUSES.map((s) => [s, s])) as Record<
  (typeof JOB_STATUSES)[number],
  (typeof JOB_STATUSES)[number]
>;
registerEnumType(JobStatusEnum, { name: 'JobStatus' });

@ObjectType()
export class Job {
  @Field() id: string;
  @Field() recordingId: string;
  @Field(() => JobStatusEnum) status: keyof typeof JobStatusEnum;
  @Field() modelRegistryId: string;
  @Field() languagePolicy: string;
  @Field() force: boolean;
  @Field(() => Float) progressSeconds: number;
  @Field(() => Float) totalSeconds: number;
  @Field() errorCode: string;
  @Field() errorMessage: string;
  @Field() transcriptId: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) startedAt: Date | null;
  @Field(() => Date, { nullable: true }) finishedAt: Date | null;
}

@ObjectType()
export class Recording {
  @Field() id: string;
  @Field() originalName: string;
  @Field() mediaId: string;
  @Field(() => Float) sizeBytes: number;
  @Field() sha256: string;
  @Field(() => Float) durationSeconds: number;
  @Field(() => Int) channels: number;
  @Field(() => Int) sampleRate: number;
  @Field() source: string;
  @Field() externalId: string;
  @Field(() => RecordingStatusEnum) status: keyof typeof RecordingStatusEnum;
  @Field() failureReason: string;
  @Field() latestTranscriptId: string;
  @Field() detectedLanguage: string;
  @Field(() => Float) languageProbability: number;
  @Field() createdAt: Date;
  @Field() updatedAt: Date;
  // playbackUrl, peaksUrl, jobs and latestTranscript are resolved on demand (see the resolver).
}

@ObjectType()
export class RecordingPage {
  @Field(() => [Recording]) items: Recording[];
  @Field() hasMore: boolean;
  @Field(() => String, { nullable: true, description: 'Pass as `after` to get the next page.' }) endCursor:
    string | null;
}

@ObjectType()
export class RecordingCounts {
  @Field(() => Int) uploading: number;
  @Field(() => Int) uploaded: number;
  @Field(() => Int) ready: number;
  @Field(() => Int) failed: number;
  @Field(() => Int) queued: number;
  @Field(() => Int) transcribing: number;
  @Field(() => Int) done: number;
}

@ObjectType()
export class UploadTicket {
  @Field(() => Recording) recording: Recording;
  @Field({ description: 'PUT the file here. Empty when the same content is already stored.' })
  uploadUrl: string;
  @Field(() => Date, { nullable: true }) expiresAt: Date | null;
  @Field(() => Recording, { nullable: true, description: 'The recording that already holds this content.' })
  duplicateOf: Recording | null;
}

@InputType()
export class RequestUploadInput {
  @Field() originalName: string;
  @Field(() => Float) sizeBytes: number;
  @Field({ nullable: true }) contentType?: string;
  @Field({ nullable: true, description: 'When known: the same content is not uploaded twice.' })
  sha256?: string;
  @Field({ nullable: true, description: 'Your own id for the call.' }) externalId?: string;
}

@InputType()
export class CreateJobInput {
  @Field() recordingId: string;
  @Field({ nullable: true, description: 'Empty = the default model.' }) modelRegistryId?: string;
  @Field({ nullable: true, description: '"auto" or a language code to force.' }) languagePolicy?: string;
  @Field({ nullable: true, description: 'Transcribe again even if a transcript exists.' }) force?: boolean;
}

@InputType()
export class RecordingFilter {
  @Field(() => [RecordingStatusEnum], { nullable: true }) status?: (keyof typeof RecordingStatusEnum)[];
  @Field({ nullable: true, description: 'Part of the file name or the external id.' }) search?: string;
}
