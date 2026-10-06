/** Workspace settings and API keys. Admins only for changes and for the keys. */
import { Args, Field, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { AuditService } from '../audit/audit.service.js';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import { AuthService, type Principal } from '../auth/auth.service.js';
import { Settings, SettingsInput } from './settings.graphql.js';
import { SettingsService } from './settings.service.js';

@ObjectType()
export class ApiKey {
  @Field() id: string;
  @Field() name: string;
  @Field() createdAt: Date;
  @Field(() => Date, { nullable: true }) lastUsedAt: Date | null;
  @Field(() => Date, { nullable: true }) revokedAt: Date | null;
}

@ObjectType()
export class NewApiKey {
  @Field() id: string;
  @Field({ description: 'Shown once. Send it as "Authorization: Bearer <key>".' }) key: string;
}

@Resolver()
export class SettingsResolver {
  constructor(
    private readonly store: SettingsService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Query(() => Settings, { description: 'Every setting of the workspace, the defaults filled in.' })
  settings(@CurrentUser() me: Principal): Promise<Settings> {
    return this.store.read(me.workspaceId);
  }

  @AdminOnly()
  @Mutation(() => Settings, { description: 'Changes the settings given; the rest keep their values.' })
  async updateSettings(@CurrentUser() me: Principal, @Args('input') input: SettingsInput): Promise<Settings> {
    const { settings, changed } = await this.store.update(me.workspaceId, input, me.userId);
    if (changed.length > 0) {
      await this.audit.record(
        me,
        'settings.updated',
        { kind: 'workspace', id: me.workspaceId },
        { keys: changed },
      );
    }
    return settings;
  }

  @AdminOnly()
  @Query(() => [ApiKey])
  async apiKeys(@CurrentUser() me: Principal): Promise<ApiKey[]> {
    return this.auth.listApiKeys(me.workspaceId);
  }

  @AdminOnly()
  @Mutation(() => NewApiKey, { description: 'Makes a key for scripts and connectors.' })
  async createApiKey(@CurrentUser() me: Principal, @Args('name') name: string): Promise<NewApiKey> {
    const made = await this.auth.createApiKey(me.workspaceId, name, me.userId);
    await this.audit.record(me, 'api_key.created', { kind: 'api_key', id: made.id }, { name: name.trim() });
    return made;
  }

  @AdminOnly()
  @Mutation(() => Boolean)
  async revokeApiKey(@CurrentUser() me: Principal, @Args('id') id: string): Promise<boolean> {
    await this.auth.revokeApiKey(me.workspaceId, id);
    await this.audit.record(me, 'api_key.revoked', { kind: 'api_key', id });
    return true;
  }
}
