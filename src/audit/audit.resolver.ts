/** The audit log, for admins. */
import { Args, Field, InputType, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { type AuditRow, AuditService } from './audit.service.js';

@ObjectType({ description: 'One change: who did what to which thing.' })
export class AuditEntry {
  @Field() id: string;
  @Field({ description: "'user' or 'api_key'." }) actorKind: string;
  @Field() actorId: string;
  @Field() actorName: string;
  @Field({ description: "What happened: 'recording.deleted', 'user.invited', ..." }) action: string;
  @Field() targetKind: string;
  @Field() targetId: string;
  @Field({ description: 'What changed, as JSON text.' }) details: string;
  @Field() ip: string;
  @Field() createdAt: Date;
}

@ObjectType()
export class AuditPage {
  @Field(() => [AuditEntry]) items: AuditEntry[];
  @Field() hasMore: boolean;
  @Field(() => String, { nullable: true }) endCursor: string | null;
}

@InputType()
export class AuditFilterInput {
  @Field({ nullable: true }) action?: string;
  @Field({ nullable: true }) targetKind?: string;
  @Field({ nullable: true }) targetId?: string;
  @Field({ nullable: true }) actorId?: string;
}

export function auditEntry(row: AuditRow): AuditEntry {
  return { ...row, details: JSON.stringify(row.details) };
}

@Resolver()
export class AuditResolver {
  constructor(private readonly audit: AuditService) {}

  @AdminOnly()
  @Query(() => AuditPage, { description: 'Who changed what, newest first.' })
  async auditLog(
    @CurrentUser() me: Principal,
    @Args('filter', { nullable: true }) filter?: AuditFilterInput,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { nullable: true }) after?: string,
  ): Promise<AuditPage> {
    const page = await this.audit.list(me.workspaceId, {
      ...filter,
      after: after ?? undefined,
      limit: first ?? undefined,
    });
    return {
      items: page.items.map(auditEntry),
      hasMore: page.hasMore,
      endCursor: page.items.at(-1)?.id ?? null,
    };
  }
}
