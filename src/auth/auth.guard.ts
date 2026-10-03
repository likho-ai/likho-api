import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { parse as parseCookies } from 'cookie';
import type { Request } from 'express';
import { forbidden, unauthenticated } from '../common/errors.js';
import { AuthService, type Principal, SESSION_COOKIE } from './auth.service.js';

export const IS_PUBLIC = 'likho:public';
/** Marks a route or field that needs no sign-in (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ADMIN_ONLY = 'likho:admin';
/** Marks a route or field only an admin may use. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

export interface RequestWithPrincipal extends Request {
  principal?: Principal;
}

export function requestOf(context: ExecutionContext): RequestWithPrincipal {
  if (context.getType<'graphql' | 'http'>() === 'graphql') {
    return GqlExecutionContext.create(context).getContext<{ req: RequestWithPrincipal }>().req;
  }
  return context.switchToHttp().getRequest<RequestWithPrincipal>();
}

/**
 * Finds out who is asking, on every request: the session cookie for browsers, or
 * `Authorization: Bearer lk_...` for scripts. Public routes pass without either.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestOf(context);
    request.principal = (await this.identify(request)) ?? undefined;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (!request.principal) throw unauthenticated();
    if (
      this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, targets) &&
      request.principal.role !== 'admin'
    ) {
      throw forbidden('Only an admin can do this.');
    }
    return true;
  }

  private async identify(request: Request): Promise<Principal | null> {
    const authorization = request.headers.authorization ?? '';
    if (authorization.startsWith('Bearer ')) {
      return this.auth.fromApiKey(authorization.slice('Bearer '.length).trim());
    }
    const token = parseCookies(request.headers.cookie ?? '')[SESSION_COOKIE];
    return token ? this.auth.fromSession(token) : null;
  }
}

/** The principal of the request, for resolvers and controllers. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const principal = requestOf(context).principal;
  if (!principal) throw unauthenticated();
  return principal;
});
