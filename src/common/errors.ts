/**
 * Errors with a code, shown to people in plain words. GraphQL carries the code in
 * `extensions.code`; REST answers `{"error": {"code", "message"}}`, the shape every Likho HTTP
 * API uses.
 */
import { HttpException, HttpStatus } from '@nestjs/common';

export type ErrorCode =
  'unauthenticated' | 'forbidden' | 'not_found' | 'invalid' | 'conflict' | 'service_unavailable';

const STATUS: Record<ErrorCode, HttpStatus> = {
  unauthenticated: HttpStatus.UNAUTHORIZED,
  forbidden: HttpStatus.FORBIDDEN,
  not_found: HttpStatus.NOT_FOUND,
  invalid: HttpStatus.BAD_REQUEST,
  conflict: HttpStatus.CONFLICT,
  service_unavailable: HttpStatus.SERVICE_UNAVAILABLE,
};

export class LikhoError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super({ error: { code, message } }, STATUS[code]);
    this.message = message;
  }
}

export const notFound = (what: string) => new LikhoError('not_found', `${what} was not found.`);
export const invalid = (message: string) => new LikhoError('invalid', message);
export const forbidden = (message = 'You are not allowed to do this.') =>
  new LikhoError('forbidden', message);
export const unauthenticated = () => new LikhoError('unauthenticated', 'Sign in first.');
