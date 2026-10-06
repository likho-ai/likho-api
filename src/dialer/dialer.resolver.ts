import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import {
  DialerAgent,
  DialerCall,
  DialerCallPage,
  DialerCallsFilter,
  DialerCampaign,
  DialerStatus,
} from './dialer.graphql.js';
import { DialerService } from './dialer.service.js';

@Resolver()
export class DialerResolver {
  constructor(private readonly service: DialerService) {}

  @Query(() => [DialerCampaign], {
    description: 'The dialer’s campaigns that had calls between since and until, most calls first.',
  })
  dialerCampaigns(
    @Args('since', { type: () => Date }) since: Date,
    @Args('until', { type: () => Date }) until: Date,
  ): Promise<DialerCampaign[]> {
    return this.service.campaigns({ since, until });
  }

  @Query(() => [DialerAgent], {
    description: 'The dialer’s agents that took calls in the window (of one campaign when given).',
  })
  dialerAgents(
    @Args('since', { type: () => Date }) since: Date,
    @Args('until', { type: () => Date }) until: Date,
    @Args('campaign', { nullable: true }) campaign?: string,
  ): Promise<DialerAgent[]> {
    return this.service.agents({ since, until }, campaign ?? '');
  }

  @Query(() => DialerCallPage, {
    description:
      'The dialer’s calls of the window, newest first, a page at a time; each says whether Likho has it already.',
  })
  dialerCalls(
    @CurrentUser() me: Principal,
    @Args('filter') filter: DialerCallsFilter,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { nullable: true }) after?: string,
  ): Promise<DialerCallPage> {
    return this.service.calls(me.workspaceId, filter, first ?? 50, after ?? '');
  }

  @Query(() => DialerCall, { description: 'One call of the dialer by the interaction’s id.' })
  dialerCall(@CurrentUser() me: Principal, @Args('crtObjectId') crtObjectId: string): Promise<DialerCall> {
    return this.service.call(me.workspaceId, crtObjectId);
  }

  @Query(() => DialerStatus, { description: 'What the dialer connector is doing: schedule, budget, cursor.' })
  dialerStatus(): Promise<DialerStatus> {
    return this.service.status();
  }
}
