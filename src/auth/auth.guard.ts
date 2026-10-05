import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { parse as parseCookies } from 'cookie';
import type { Request } from 'express';
import { forbidden, unauthenticated } from '../common/errors.js';
import {
  AuthService,
  EXCHANGED_TOKEN_PREFIX,
  type Principal,
  type Role,
  SESSION_COOKIE,
} from './auth.service.js';

export const IS_PUBLIC = 'likho:public';
/** Marks a route or field that needs no sign-in (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const MIN_ROLE = 'likho:min-role';
/** Marks a route or field that needs at least this role (viewer < member < admin). */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE, role);
/** Marks a route or field only an admin may use. */
export const AdminOnly = () => MinRole('admin');

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2 };

export interface RequestWithPrincipal extends Request {
  principal?: Principal;
}

export function requestOf(context: ExecutionContext): RequestWithPrincipal {
  if (context.getType<'graphql' | 'http'>() === 'graphql') {
    return GqlExecutionContext.create(context).getContext<{ req: RequestWithPrincipal }>().req;
  }
  return context.switchToHttp().getRequest<RequestWithPrincipal>();
}

/** The caller's address: the first hop the gateway saw, or the socket's. */
export function ipOf(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || request.socket?.remoteAddress || '';
}

/**
 * Finds out who is asking, on every request: the session cookie for browsers, or
 * `Authorization: Bearer lk_...` for scripts. Public routes pass without either; the others
 * need a sign-in, and some a role.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = requestOf(context);
    const principal = await this.identify(request);
    if (principal) principal.ip = ipOf(request);
    request.principal = principal ?? undefined;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (!principal) throw unauthenticated();
    const needed = this.reflector.getAllAndOverride<Role | undefined>(MIN_ROLE, targets);
    if (needed && RANK[principal.role] < RANK[needed]) {
      throw forbidden(needed === 'admin' ? 'Only an admin can do this.' : 'A viewer can read, not change.');
    }
    return true;
  }

  private async identify(request: Request): Promise<Principal | null> {
    const authorization = request.headers.authorization ?? '';
    if (authorization.startsWith('Bearer ')) {
      const bearer = authorization.slice('Bearer '.length).trim();
      // lk_ is an API key (a script, a connector); lt_ a token one exchanged itself for (a portal's browser).
      return bearer.startsWith(EXCHANGED_TOKEN_PREFIX)
        ? this.auth.fromExchangedToken(bearer)
        : this.auth.fromApiKey(bearer);
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
