import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Import, ImportPage, ImportStatusEnum, RequestImportInput } from './imports.graphql.js';
import { ImportsService } from './imports.service.js';

@Resolver(() => Import)
export class ImportsResolver {
  constructor(
    private readonly service: ImportsService,
    private readonly audit: AuditService,
  ) {}

  @MinRole('member')
  @Mutation(() => Import, {
    description: 'Asks the dialer connector for a call by its id; the recording appears when it arrives.',
  })
  async requestImport(
    @CurrentUser() me: Principal,
    @Args('input') input: RequestImportInput,
  ): Promise<Import> {
    const row = await this.service.request(me.workspaceId, me.userId, input);
    await this.audit.record(
      me,
      'import.requested',
      { kind: 'import', id: row.id },
      {
        source: row.source,
        externalId: row.externalId,
      },
    );
    return row;
  }

  @Query(() => ImportPage, { description: 'Calls asked for from the dialer, newest first.' })
  async imports(
    @CurrentUser() me: Principal,
    @Args('status', { type: () => [ImportStatusEnum], nullable: true })
    status?: (keyof typeof ImportStatusEnum)[],
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { nullable: true }) after?: string,
  ): Promise<ImportPage> {
    return this.service.list(me.workspaceId, {
      status,
      after: after ?? undefined,
      limit: first ?? undefined,
    });
  }

  @Query(() => Import)
  async import(@CurrentUser() me: Principal, @Args('id') id: string): Promise<Import> {
    return this.service.get(me.workspaceId, id);
  }
}
