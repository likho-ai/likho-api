/** The workspace's settings as the admin app reads and changes them. */
import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'What the dialer connector does for this workspace.' })
export class DialerSettings {
  @Field({ description: 'The schedule runs: new calls are fetched from the dialer every so often.' })
  scheduleEnabled: boolean;
  @Field(() => [String], { description: 'The campaigns the schedule takes; empty = every campaign.' })
  campaigns: string[];
  @Field(() => Int, { description: 'Calls with less customer talk time than this (seconds) are left out.' })
  minTalkSeconds: number;
  @Field(() => Int, { description: 'How many calls the schedule fetches a day at most.' })
  dailyLimit: number;
  @Field(() => Int, { description: 'How many calls one run fetches at most.' }) batchLimit: number;
  @Field(() => Int, { description: 'How often the schedule looks for new calls, in seconds.' })
  pollIntervalSeconds: number;
  @Field(() => Int, { description: 'Digits of a phone number kept on a recording; 0 = none.' })
  phoneDigits: number;
  @Field({ description: 'Transcripts are written back to the CRM.' }) writebackEnabled: boolean;
}

@ObjectType()
export class Settings {
  @Field({ description: 'Queue a job as soon as a recording is ready.' }) autoTranscribe: boolean;
  @Field(() => DialerSettings) dialer: DialerSettings;
}

@InputType()
export class DialerSettingsInput {
  @Field({ nullable: true }) scheduleEnabled?: boolean;
  @Field(() => [String], { nullable: true }) campaigns?: string[];
  @Field(() => Int, { nullable: true }) minTalkSeconds?: number;
  @Field(() => Int, { nullable: true }) dailyLimit?: number;
  @Field(() => Int, { nullable: true }) batchLimit?: number;
  @Field(() => Int, { nullable: true }) pollIntervalSeconds?: number;
  @Field(() => Int, { nullable: true }) phoneDigits?: number;
  @Field({ nullable: true }) writebackEnabled?: boolean;
}

@InputType({ description: 'The settings to change; a field left out keeps its value.' })
export class SettingsInput {
  @Field({ nullable: true }) autoTranscribe?: boolean;
  @Field(() => DialerSettingsInput, { nullable: true }) dialer?: DialerSettingsInput;
}
