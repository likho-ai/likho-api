/** Workspace settings and API keys. Admins only for the keys. */
import { Args, Field, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import { AuthService, type Principal } from '../auth/auth.service.js';
import { RecordingsService } from '../recordings/recordings.service.js';

@ObjectType()
export class Settings {
  @Field({ description: 'Queue a job as soon as a recording is ready.' }) autoTranscribe: boolean;
}

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
    private readonly recordings: RecordingsService,
    private readonly auth: AuthService,
  ) {}

  @Query(() => Settings)
  async settings(@CurrentUser() me: Principal): Promise<Settings> {
    return { autoTranscribe: await this.recordings.autoTranscribe(me.workspaceId) };
  }

  @AdminOnly()
  @Mutation(() => Settings)
  async updateSettings(
    @CurrentUser() me: Principal,
    @Args('autoTranscribe') autoTranscribe: boolean,
  ): Promise<Settings> {
    await this.recordings.setAutoTranscribe(me.workspaceId, autoTranscribe);
    return { autoTranscribe };
  }

  @AdminOnly()
  @Query(() => [ApiKey])
  async apiKeys(@CurrentUser() me: Principal): Promise<ApiKey[]> {
    return this.auth.listApiKeys(me.workspaceId);
  }

  @AdminOnly()
  @Mutation(() => NewApiKey, { description: 'Makes a key for scripts and connectors.' })
  async createApiKey(@CurrentUser() me: Principal, @Args('name') name: string): Promise<NewApiKey> {
    return this.auth.createApiKey(me.workspaceId, name, me.userId);
  }

  @AdminOnly()
  @Mutation(() => Boolean)
  async revokeApiKey(@CurrentUser() me: Principal, @Args('id') id: string): Promise<boolean> {
    await this.auth.revokeApiKey(me.workspaceId, id);
    return true;
  }
}
