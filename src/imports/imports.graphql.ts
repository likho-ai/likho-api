/** The GraphQL shapes of imports: calls asked for by their id in the dialer. */
import { Field, InputType, ObjectType, registerEnumType } from '@nestjs/graphql';
import { IMPORT_STATUSES } from '../db/schema.js';

export const ImportStatusEnum = Object.fromEntries(IMPORT_STATUSES.map((s) => [s, s])) as Record<
  (typeof IMPORT_STATUSES)[number],
  (typeof IMPORT_STATUSES)[number]
>;
registerEnumType(ImportStatusEnum, { name: 'ImportStatus' });

@ObjectType()
export class Import {
  @Field() id: string;
  @Field({ description: 'Which connector: ameyo.' }) source: string;
  @Field({ description: 'The call’s id in that system.' }) externalId: string;
  @Field() transcribe: boolean;
  @Field(() => ImportStatusEnum) status: keyof typeof ImportStatusEnum;
  @Field({ description: 'The recording, once the call is stored.' }) recordingId: string;
  @Field({ description: 'Why it failed, for a person.' }) reason: string;
  @Field({ description: 'not_found, no_recording, unavailable, rejected or error.' }) code: string;
  @Field() createdAt: Date;
  @Field() updatedAt: Date;
}

@ObjectType()
export class ImportPage {
  @Field(() => [Import]) items: Import[];
  @Field() hasMore: boolean;
}

@InputType()
export class RequestImportInput {
  @Field({ description: 'The call’s id in the dialer (its crt_object_id).' }) externalId: string;
  @Field({ nullable: true, description: 'Which connector; empty = the default one.' }) source?: string;
  @Field({ nullable: true, description: 'Transcribe once stored (default true).' }) transcribe?: boolean;
}
