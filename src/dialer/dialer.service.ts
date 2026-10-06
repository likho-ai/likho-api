/**
 * What the dialer knows about its calls, asked of the dialer connector (likho.dialer.v1) and
 * joined with what Likho already has: a call that was fetched carries its recording.
 */
import { Injectable } from '@nestjs/common';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { and, eq, inArray } from 'drizzle-orm';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { invalid } from '../common/errors.js';
import { DbService } from '../db/db.module.js';
import { recordings } from '../db/schema.js';
import {
  agentFromPb,
  callFromPb,
  campaignFromPb,
  statusFromPb,
  type DialerAgent,
  type DialerCall,
  type DialerCallPage,
  type DialerCampaign,
  type DialerStatus,
} from './dialer.graphql.js';

export interface Window {
  since: Date;
  until: Date;
}

export interface CallsFilter extends Window {
  campaign?: string;
  agent?: string;
  connectedOnly?: boolean;
  minTalkSeconds?: number;
}

const MAX_DAYS = 92;
const PAGE = { usual: 50, most: 500 };

@Injectable()
export class DialerService {
  constructor(
    private readonly clients: Clients,
    private readonly dbs: DbService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  async campaigns(window: Window): Promise<DialerCampaign[]> {
    const checked = windowPb(checkWindow(window));
    try {
      const reply = await this.clients.dialer.listCampaigns({ window: checked });
      return reply.campaigns.map(campaignFromPb);
    } catch (error) {
      throw fromRpc(error, 'dialer connector');
    }
  }

  async agents(window: Window, campaign = ''): Promise<DialerAgent[]> {
    const checked = windowPb(checkWindow(window));
    try {
      const reply = await this.clients.dialer.listAgents({
        window: checked,
        campaign,
      });
      return reply.agents.map(agentFromPb);
    } catch (error) {
      throw fromRpc(error, 'dialer connector');
    }
  }

  /** The calls of the window, newest first, with the recording of each call Likho has. */
  async calls(
    workspaceId: string,
    filter: CallsFilter,
    first = PAGE.usual,
    after = '',
  ): Promise<DialerCallPage> {
    const limit = Math.min(Math.max(first, 1), PAGE.most);
    let calls: DialerCall[];
    let nextCursor: string;
    const checked = windowPb(checkWindow(filter));
    try {
      const reply = await this.clients.dialer.listCalls({
        window: checked,
        campaign: filter.campaign ?? '',
        agent: filter.agent ?? '',
        connectedOnly: filter.connectedOnly ?? true,
        minTalkSeconds: Math.max(0, filter.minTalkSeconds ?? 0),
        after,
        limit,
      });
      calls = reply.calls.map(callFromPb);
      nextCursor = reply.nextCursor;
    } catch (error) {
      throw fromRpc(error, 'dialer connector');
    }
    await this.attachRecordings(workspaceId, calls);
    return { items: calls, nextCursor: nextCursor || null };
  }

  async call(workspaceId: string, crtObjectId: string): Promise<DialerCall> {
    let call: DialerCall;
    try {
      const reply = await this.clients.dialer.getCall({ crtObjectId });
      call = callFromPb(reply.call!);
    } catch (error) {
      throw fromRpc(error, 'dialer connector');
    }
    await this.attachRecordings(workspaceId, [call]);
    return call;
  }

  async status(): Promise<DialerStatus> {
    try {
      return statusFromPb(await this.clients.dialer.getStatus({}));
    } catch (error) {
      throw fromRpc(error, 'dialer connector');
    }
  }

  /** Marks each call that is already a recording of the workspace (by the dialer's id). */
  private async attachRecordings(workspaceId: string, calls: DialerCall[]): Promise<void> {
    const ids = [...new Set(calls.map((c) => c.crtObjectId).filter(Boolean))];
    if (ids.length === 0) return;
    const rows = await this.db
      .select({ id: recordings.id, externalId: recordings.externalId, status: recordings.status })
      .from(recordings)
      .where(and(eq(recordings.workspaceId, workspaceId), inArray(recordings.externalId, ids)));
    const byExternal = new Map(rows.map((r) => [r.externalId, r]));
    for (const call of calls) {
      const found = byExternal.get(call.crtObjectId);
      if (found) {
        call.recordingId = found.id;
        call.recordingStatus = found.status;
      }
    }
  }
}

/** A window as the connector wants it; what is wrong with it is said here. */
export function checkWindow(window: Window): Window {
  const { since, until } = window;
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()))
    throw invalid('since and until must be dates.');
  if (until <= since) throw invalid('until must come after since.');
  if (until.getTime() - since.getTime() > MAX_DAYS * 86_400_000)
    throw invalid(`A window of the dialer’s calls spans at most ${MAX_DAYS} days.`);
  return window;
}

function windowPb(window: Window) {
  return { since: timestampFromDate(window.since), until: timestampFromDate(window.until) };
}
