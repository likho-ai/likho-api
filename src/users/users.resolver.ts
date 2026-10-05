/** People of the workspace and their invitations. Admins only; signing in through a link is in AuthResolver. */
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuditService } from '../audit/audit.service.js';
import { AdminOnly, CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Invitation, InviteUserInput, NewInvitation, RoleEnum, User } from './users.graphql.js';
import { UsersService } from './users.service.js';

@Resolver()
export class UsersResolver {
  constructor(
    private readonly service: UsersService,
    private readonly audit: AuditService,
  ) {}

  @AdminOnly()
  @Query(() => [User], { description: 'The people of the workspace, newest first.' })
  async users(@CurrentUser() me: Principal): Promise<User[]> {
    return this.service.list(me.workspaceId) as Promise<User[]>;
  }

  @AdminOnly()
  @Query(() => [Invitation], {
    description: 'Invitations sent, newest first, accepted and revoked ones too.',
  })
  async invitations(@CurrentUser() me: Principal): Promise<Invitation[]> {
    return this.service.listInvitations(me.workspaceId) as Promise<Invitation[]>;
  }

  @AdminOnly()
  @Mutation(() => NewInvitation, {
    description:
      'Invites a person by email: a one-time link, good for seven days, mailed when mail is set up and returned to you either way.',
  })
  async inviteUser(
    @CurrentUser() me: Principal,
    @Args('input') input: InviteUserInput,
  ): Promise<NewInvitation> {
    const made = await this.service.invite(me.workspaceId, me.userId, input);
    await this.audit.record(
      me,
      'user.invited',
      { kind: 'invitation', id: made.invitation.id },
      { email: made.invitation.email, role: made.invitation.role, sent: made.sent },
    );
    return made as NewInvitation;
  }

  @AdminOnly()
  @Mutation(() => Boolean, { description: 'Makes an invitation link useless.' })
  async revokeInvitation(@CurrentUser() me: Principal, @Args('id') id: string): Promise<boolean> {
    const revoked = await this.service.revokeInvitation(me.workspaceId, id);
    await this.audit.record(me, 'invitation.revoked', { kind: 'invitation', id }, { email: revoked.email });
    return true;
  }

  @AdminOnly()
  @Mutation(() => User, {
    description: 'Changes what a person may do. You cannot take your own admin role away.',
  })
  async setUserRole(
    @CurrentUser() me: Principal,
    @Args('userId') userId: string,
    @Args('role', { type: () => RoleEnum }) role: RoleEnum,
  ): Promise<User> {
    const before = await this.service.get(me.workspaceId, userId);
    const user = await this.service.setRole(me.workspaceId, me.userId, userId, role);
    await this.audit.record(
      me,
      'user.role_changed',
      { kind: 'user', id: userId },
      { email: user.email, from: before.role, to: role },
    );
    return user as User;
  }

  @AdminOnly()
  @Mutation(() => User, { description: 'The person cannot sign in any more; their sessions end now.' })
  async disableUser(@CurrentUser() me: Principal, @Args('userId') userId: string): Promise<User> {
    const user = await this.service.disable(me.workspaceId, me.userId, userId);
    await this.audit.record(me, 'user.disabled', { kind: 'user', id: userId }, { email: user.email });
    return user as User;
  }

  @AdminOnly()
  @Mutation(() => User, { description: 'The person can sign in again.' })
  async enableUser(@CurrentUser() me: Principal, @Args('userId') userId: string): Promise<User> {
    const user = await this.service.enable(me.workspaceId, userId);
    await this.audit.record(me, 'user.enabled', { kind: 'user', id: userId }, { email: user.email });
    return user as User;
  }
}
