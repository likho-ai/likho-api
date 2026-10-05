import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Recording } from '../recordings/recordings.graphql.js';
import type { RecordingRow } from '../recordings/recordings.service.js';
import { Insights, InsightsStatus } from './insights.graphql.js';
import { InsightsService } from './insights.service.js';

@Resolver(() => Recording)
export class InsightsResolver {
  constructor(
    private readonly service: InsightsService,
    private readonly audit: AuditService,
  ) {}

  @ResolveField(() => Insights, {
    nullable: true,
    description: 'What a language model says about the call, once it has been analysed.',
  })
  async insights(@Parent() recording: RecordingRow): Promise<Insights | null> {
    return this.service.forRow(recording);
  }

  @Query(() => Insights, {
    name: 'insights',
    nullable: true,
    description: 'The newest insights of a recording, or null when it has none yet.',
  })
  async insightsOf(
    @CurrentUser() me: Principal,
    @Args('recordingId') recordingId: string,
  ): Promise<Insights | null> {
    return this.service.forRecording(me.workspaceId, recordingId);
  }

  @Query(() => InsightsStatus, {
    description: 'Whether insights are made at all (a model is configured) and by which model.',
  })
  async insightsStatus(): Promise<InsightsStatus> {
    return this.service.status();
  }

  @MinRole('member')
  @Mutation(() => Insights, {
    description:
      'Analyses the recording’s latest transcript now and answers with its insights; with force, again even when it has some.',
  })
  async analyseRecording(
    @CurrentUser() me: Principal,
    @Args('id') id: string,
    @Args('force', { nullable: true }) force?: boolean,
  ): Promise<Insights> {
    const insights = await this.service.analyse(me.workspaceId, id, Boolean(force));
    await this.audit.record(
      me,
      'insights.requested',
      { kind: 'recording', id },
      { transcriptId: insights.transcriptId, force: Boolean(force), model: insights.model },
    );
    return insights;
  }
}
