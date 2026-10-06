/** What the dialer knows about its calls, as the web app reads it, mapped from likho.dialer.v1. */
import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import type {
  Agent as AgentPb,
  Call as CallPb,
  Campaign as CampaignPb,
  GetStatusResponse,
} from '@likho-ai/contracts/dialer/v1/dialer_pb';

@ObjectType({ description: 'A campaign of the dialer, with its calls in the window.' })
export class DialerCampaign {
  @Field() name: string;
  @Field(() => Int, { description: 'Legs the dialer logged (a transferred call has two).' }) calls: number;
  @Field(() => Int, { description: 'Of those, the ones that connected.' }) connected: number;
  @Field(() => Int, { description: 'Interactions: one recording each.' }) interactions: number;
  @Field(() => Int, { description: 'Customer talk time of the connected legs, in seconds.' })
  talkSeconds: number;
}

@ObjectType({ description: 'An agent of the dialer, with the calls taken in the window.' })
export class DialerAgent {
  @Field({ description: 'The dialer’s user id.' }) id: string;
  @Field({ description: 'The dialer’s user name.' }) name: string;
  @Field(() => Int) calls: number;
  @Field(() => Int) connected: number;
  @Field(() => Int) talkSeconds: number;
}

@ObjectType({ description: 'One leg of a call as the dialer logged it.' })
export class DialerCall {
  @Field({ description: 'The interaction’s id: the key of the recording.' }) crtObjectId: string;
  @Field({ description: 'The leg’s id.' }) callId: string;
  @Field({ description: 'When the call happened, as the dialer writes it (its own clock).' })
  callTime: string;
  @Field() campaign: string;
  @Field({ description: 'The campaign the call was transferred to, when it was.' })
  transferredCampaign: string;
  @Field() agent: string;
  @Field() agentId: string;
  @Field() disposition: string;
  @Field({ description: 'inbound, outbound, transferred: the dialer’s own words.' }) callType: string;
  @Field() connected: boolean;
  @Field(() => Int, { description: 'Customer talk time, in seconds.' }) talkSeconds: number;
  @Field({ description: 'Shortened to the digits the connector may show.' }) phone: string;
  @Field({ description: 'Who hung up: customer, agent, system.' }) hangupBy: string;
  @Field() queue: string;
  @Field(() => String, {
    nullable: true,
    description: 'The recording in Likho, when this call was fetched already.',
  })
  recordingId: string | null;
  @Field(() => String, { nullable: true, description: 'Its status in Likho, when fetched.' })
  recordingStatus: string | null;
}

@ObjectType()
export class DialerCallPage {
  @Field(() => [DialerCall]) items: DialerCall[];
  @Field(() => String, { nullable: true, description: 'Pass as `after` for the next page; null at the end.' })
  nextCursor: string | null;
}

@ObjectType({ description: 'What the dialer connector is doing for this workspace.' })
export class DialerStatus {
  @Field({ description: 'The reporting database is configured: lists and the schedule are possible.' })
  databaseConfigured: boolean;
  @Field() scheduleEnabled: boolean;
  @Field({ description: 'Where the schedule stands: the dialer’s call time of the last call taken.' })
  cursor: string;
  @Field(() => Int) importedToday: number;
  @Field(() => Int) dailyLimit: number;
  @Field(() => [String]) campaigns: string[];
  @Field(() => Int) minTalkSeconds: number;
  @Field() writebackEnabled: boolean;
  @Field({ description: 'The archive of old recordings is looked in when the live server has none.' })
  archiveEnabled: boolean;
  @Field() version: string;
  @Field(() => Date, { nullable: true }) lastRunAt: Date | null;
  @Field() lastRunSummary: string;
}

@InputType({ description: 'Which calls of the dialer; since and until are required.' })
export class DialerCallsFilter {
  @Field(() => Date) since: Date;
  @Field(() => Date) until: Date;
  @Field({ nullable: true }) campaign?: string;
  @Field({ nullable: true }) agent?: string;
  @Field({ nullable: true, description: 'Only calls that connected (default true).' })
  connectedOnly?: boolean;
  @Field(() => Int, { nullable: true, description: 'Only calls with at least this much talk time.' })
  minTalkSeconds?: number;
}

export function campaignFromPb(c: CampaignPb): DialerCampaign {
  return {
    name: c.name,
    calls: Number(c.calls),
    connected: Number(c.connected),
    interactions: Number(c.interactions),
    talkSeconds: Number(c.talkSeconds),
  };
}

export function agentFromPb(a: AgentPb): DialerAgent {
  return {
    id: a.id,
    name: a.name,
    calls: Number(a.calls),
    connected: Number(a.connected),
    talkSeconds: Number(a.talkSeconds),
  };
}

export function callFromPb(c: CallPb): DialerCall {
  return {
    crtObjectId: c.crtObjectId,
    callId: c.callId,
    callTime: c.callTime,
    campaign: c.campaign,
    transferredCampaign: c.transferredCampaign,
    agent: c.agent,
    agentId: c.agentId,
    disposition: c.disposition,
    callType: c.callType,
    connected: c.connected,
    talkSeconds: c.talkSeconds,
    phone: c.phone,
    hangupBy: c.hangupBy,
    queue: c.queue,
    recordingId: null,
    recordingStatus: null,
  };
}

export function statusFromPb(s: GetStatusResponse): DialerStatus {
  return {
    databaseConfigured: s.databaseConfigured,
    scheduleEnabled: s.scheduleEnabled,
    cursor: s.cursor,
    importedToday: s.importedToday,
    dailyLimit: s.dailyLimit,
    campaigns: s.campaigns,
    minTalkSeconds: s.minTalkSeconds,
    writebackEnabled: s.writebackEnabled,
    archiveEnabled: s.archiveEnabled,
    version: s.version,
    lastRunAt: s.lastRunAt ? new Date(Number(s.lastRunAt.seconds) * 1000) : null,
    lastRunSummary: s.lastRunSummary,
  };
}
