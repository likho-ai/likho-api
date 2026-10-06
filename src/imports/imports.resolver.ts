import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Import, ImportPage, ImportStatusEnum, RequestImportInput } from './imports.graphql.js';
import { invalid } from '../common/errors.js';
import { ImportsService } from './imports.service.js';

@Resolver(() => Import)
export class ImportsResolver {
  constructor(
    private readonly service: ImportsService,
    private readonly audit: AuditService,
  ) {}

  @MinRole('member')
  @Mutation(() => [Import], {
    description: 'Asks the dialer connector for several calls by their ids (at most 200 at a time).',
  })
  async requestImports(
    @CurrentUser() me: Principal,
    @Args('externalIds', { type: () => [String] }) externalIds: string[],
    @Args('source', { nullable: true }) source?: string,
  ): Promise<Import[]> {
    const ids = [...new Set(externalIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) throw invalid('Give at least one call id.');
    if (ids.length > 200) throw invalid('At most 200 calls at a time.');
    const rows: Import[] = [];
    for (const externalId of ids) {
      const row = await this.service.request(me.workspaceId, me.userId, { externalId, source });
      rows.push(row);
    }
    await this.audit.record(
      me,
      'import.requested',
      { kind: 'import', id: rows[0]!.id },
      { source: rows[0]!.source, externalIds: ids, count: ids.length },
    );
    return rows;
  }

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
