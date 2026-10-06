import { Query, Resolver } from '@nestjs/graphql';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { SystemStatus } from './system.graphql.js';
import { SystemService } from './system.service.js';

@Resolver()
export class SystemResolver {
  constructor(private readonly system: SystemService) {}

  @AdminOnly()
  @Query(() => SystemStatus, { description: 'Whether every service of the platform answers right now.' })
  systemStatus(@CurrentUser() me: Principal): Promise<SystemStatus> {
    return this.system.status(me.workspaceId);
  }
}
