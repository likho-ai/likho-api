/** The GraphQL shapes of search: a page of transcript lines matching a few words. */
import { Field, Float, InputType, Int, ObjectType } from '@nestjs/graphql';
import { Recording } from '../recordings/recordings.graphql.js';

@ObjectType()
export class SearchHit {
  @Field(() => Recording, { description: 'The recording the line is from.' }) recording: Recording;
  @Field() transcriptId: string;
  @Field(() => Int) segmentIndex: number;
  @Field(() => Float) startSeconds: number;
  @Field(() => Float) endSeconds: number;
  @Field() textRoman: string;
  @Field() textScript: string;
  @Field({ description: 'The Hinglish line with every match inside <mark>…</mark>.' }) highlightRoman: string;
  @Field({ description: 'The script line with every match inside <mark>…</mark>.' }) highlightScript: string;
  @Field() language: string;
}

@ObjectType()
export class SearchPage {
  @Field(() => [SearchHit]) hits: SearchHit[];
  @Field(() => Int) page: number;
  @Field(() => Int) pageSize: number;
  @Field(() => Int, { description: 'Lines matched in all.' }) total: number;
  @Field(() => Int) processingMs: number;
}

@InputType()
export class SearchFilter {
  @Field({ nullable: true, description: 'A detected language (ISO 639-1).' }) language?: string;
  @Field({ nullable: true, description: 'Only this recording.' }) recordingId?: string;
  @Field(() => Date, { nullable: true, description: 'Transcripts created from this moment.' }) since?: Date;
  @Field(() => Date, { nullable: true, description: 'Transcripts created up to this moment.' }) until?: Date;
  @Field({ nullable: true, description: 'The campaign attribute, exactly.' }) campaign?: string;
  @Field({ nullable: true, description: 'The agent attribute, exactly.' }) agent?: string;
  @Field({ nullable: true, description: 'The disposition attribute, exactly.' }) disposition?: string;
  @Field({ nullable: true, description: 'Where the call came from: upload, api, or a connector’s name.' })
  source?: string;
  @Field(() => Date, { nullable: true, description: 'Calls from this moment (their call time).' })
  callSince?: Date;
  @Field(() => Date, { nullable: true, description: 'Calls up to this moment (their call time).' })
  callUntil?: Date;
}

@ObjectType({ description: 'The filter of a saved search, as it was saved.' })
export class SavedSearchFilter {
  @Field({ nullable: true }) language?: string;
  @Field({ nullable: true }) recordingId?: string;
  @Field({ nullable: true }) campaign?: string;
  @Field({ nullable: true }) agent?: string;
  @Field({ nullable: true }) disposition?: string;
  @Field({ nullable: true }) source?: string;
  @Field(() => Date, { nullable: true }) since?: Date;
  @Field(() => Date, { nullable: true }) until?: Date;
  @Field(() => Date, { nullable: true }) callSince?: Date;
  @Field(() => Date, { nullable: true }) callUntil?: Date;
}

@ObjectType({ description: 'A search kept for later, shared by the workspace.' })
export class SavedSearch {
  @Field() id: string;
  @Field() name: string;
  @Field() query: string;
  @Field(() => SavedSearchFilter) filter: SavedSearchFilter;
  @Field(() => String, { nullable: true, description: 'Who saved it.' }) createdBy: string | null;
  @Field() createdAt: Date;
}
