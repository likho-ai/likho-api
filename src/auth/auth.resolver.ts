import { Args, Context, Field, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { serialize as serializeCookie } from 'cookie';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { forbidden } from '../common/errors.js';
import { CONFIG, type Config } from '../config/config.js';
import { InvitationPreview } from '../users/users.graphql.js';
import { UsersService } from '../users/users.service.js';
import { AuthService, type Principal, SESSION_COOKIE } from './auth.service.js';
import { CurrentUser, ipOf, Public } from './auth.guard.js';

@ObjectType()
export class Workspace {
  @Field() id: string;
  @Field() name: string;
}

@ObjectType()
export class Me {
  @Field(() => String, { nullable: true }) id: string | null;
  @Field() email: string;
  @Field() name: string;
  @Field({ description: 'admin, member or viewer.' }) role: string;
  @Field(() => Workspace) workspace: Workspace;
}

type GqlContext = { req: Request; res: Response };

@Resolver()
export class AuthResolver {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  private cookie(value: string, maxAgeSeconds: number): string {
    return serializeCookie(SESSION_COOKIE, value, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.PUBLIC_ORIGIN.startsWith('https://'),
      path: '/',
      maxAge: maxAgeSeconds,
    });
  }

  /** Sets the session cookie for a fresh session and returns who that is. */
  private async signedIn(token: string, context: GqlContext): Promise<Principal> {
    context.res.setHeader('Set-Cookie', this.cookie(token, this.config.SESSION_DAYS * 86_400));
    const principal = (await this.auth.fromSession(token))!;
    principal.ip = ipOf(context.req);
    return principal;
  }

  @Public()
  @Mutation(() => Me, { description: 'Signs in and sets the session cookie.' })
  async login(
    @Args('email') email: string,
    @Args('password') password: string,
    @Context() context: GqlContext,
  ): Promise<Me> {
    const { token, user } = await this.auth.login(email, password, context.req.headers['user-agent']);
    const principal = await this.signedIn(token, context);
    return this.me(principal, user.id);
  }

  @Mutation(() => Boolean, { description: 'Ends the session and clears the cookie.' })
  async logout(@CurrentUser() principal: Principal, @Context() context: GqlContext): Promise<boolean> {
    if (principal.sessionId) await this.auth.logout(principal.sessionId);
    context.res.setHeader('Set-Cookie', this.cookie('', 0));
    return true;
  }

  @Query(() => Me, { name: 'me', description: 'Who is signed in, and their workspace.' })
  async whoAmI(@CurrentUser() principal: Principal): Promise<Me> {
    return this.me(principal, principal.userId);
  }

  // ---------------------------------------------------------------- invitations

  @Public()
  @Query(() => InvitationPreview, { description: 'What an invitation link is for, before it is accepted.' })
  async invitation(@Args('token') token: string): Promise<InvitationPreview> {
    return this.users.peekInvitation(token) as Promise<InvitationPreview>;
  }

  @Public()
  @Mutation(() => Me, {
    description: 'Takes up an invitation: the person chooses a name and a password and is signed in.',
  })
  async acceptInvitation(
    @Args('token') token: string,
    @Args('name') name: string,
    @Args('password') password: string,
    @Context() context: GqlContext,
  ): Promise<Me> {
    const { token: session, user } = await this.users.accept(
      token,
      { name, password },
      context.req.headers['user-agent'],
    );
    const principal = await this.signedIn(session, context);
    await this.audit.record(
      principal,
      'invitation.accepted',
      { kind: 'user', id: user.id },
      { email: user.email, role: user.role },
    );
    return this.me(principal, user.id);
  }

  // ---------------------------------------------------------------- passwords

  @Public()
  @Mutation(() => Boolean, {
    description:
      'Mails a link to choose a new password. Always answers true, so an address cannot be probed. Without mail set up, ask an admin.',
  })
  async requestPasswordReset(@Args('email') email: string): Promise<boolean> {
    await this.users.requestPasswordReset(email);
    return true;
  }

  @Public()
  @Mutation(() => Me, { description: 'Chooses a new password through a reset link, and signs in.' })
  async resetPassword(
    @Args('token') token: string,
    @Args('password') password: string,
    @Context() context: GqlContext,
  ): Promise<Me> {
    const { token: session, user } = await this.users.resetPassword(
      token,
      password,
      context.req.headers['user-agent'],
    );
    const principal = await this.signedIn(session, context);
    await this.audit.record(
      principal,
      'user.password_reset',
      { kind: 'user', id: user.id },
      { email: user.email },
    );
    return this.me(principal, user.id);
  }

  @Mutation(() => Boolean, { description: 'Changes your own password; the current one is needed.' })
  async changePassword(
    @CurrentUser() me: Principal,
    @Args('currentPassword') currentPassword: string,
    @Args('newPassword') newPassword: string,
  ): Promise<boolean> {
    if (!me.userId) throw forbidden('An API key has no password.');
    await this.users.changePassword(me.userId, currentPassword, newPassword);
    await this.audit.record(
      me,
      'user.password_changed',
      { kind: 'user', id: me.userId },
      { email: me.email },
    );
    return true;
  }

  private async me(principal: Principal, id: string | null): Promise<Me> {
    return {
      id,
      email: principal.email,
      name: principal.name,
      role: principal.role,
      workspace: { id: principal.workspaceId, name: await this.auth.workspaceName(principal.workspaceId) },
    };
  }
}
