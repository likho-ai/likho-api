import { Args, Context, Field, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { serialize as serializeCookie } from 'cookie';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config.js';
import { AuthService, type Principal, SESSION_COOKIE } from './auth.service.js';
import { CurrentUser, Public } from './auth.guard.js';

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
  @Field() role: string;
  @Field(() => Workspace) workspace: Workspace;
}

type GqlContext = { req: Request; res: Response };

@Resolver()
export class AuthResolver {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly auth: AuthService,
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

  @Public()
  @Mutation(() => Me, { description: 'Signs in and sets the session cookie.' })
  async login(
    @Args('email') email: string,
    @Args('password') password: string,
    @Context() context: GqlContext,
  ): Promise<Me> {
    const { token, user } = await this.auth.login(email, password, context.req.headers['user-agent']);
    context.res.setHeader('Set-Cookie', this.cookie(token, this.config.SESSION_DAYS * 86_400));
    const principal = await this.auth.fromSession(token);
    return this.me(principal!, user.id);
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
