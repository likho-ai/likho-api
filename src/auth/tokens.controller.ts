/**
 * Tokens for another system's browser. A reports portal keeps a Likho API key on its server;
 * when one of its pages needs the transcript beside a call, the portal's backend exchanges the
 * key for a short-lived viewer token and hands that to the page, never the key.
 */
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from './auth.guard.js';
import { AuthService, type Principal } from './auth.service.js';

export class ExchangeDto {
  @ApiProperty({
    required: false,
    description: 'Who is looking, in the other system’s own terms (its user); kept for the audit log.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiProperty({
    required: false,
    description: 'How long the token lives: 60 to 3600 seconds (default 900).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(3600)
  ttlSeconds?: number;
}

@ApiTags('tokens')
@ApiBearerAuth()
@Controller('api/v1/tokens')
export class TokensController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Post('exchange')
  @HttpCode(200)
  @ApiOperation({
    summary: 'A short-lived viewer token for another system’s browser',
    description:
      'With an API key: a token (lt_…) that reads this workspace for at most an hour, for a page another system embeds, such as the transcript beside a call in a reports portal. The page sends it as `Authorization: Bearer`; it cannot change anything or make more tokens.',
  })
  async exchange(@CurrentUser() me: Principal, @Body() body: ExchangeDto) {
    const made = await this.auth.exchange(me, body?.subject ?? '', body?.ttlSeconds ?? 900);
    await this.audit.record(
      me,
      'token.exchanged',
      { kind: 'api_key', id: me.apiKeyId ?? '' },
      { subject: body?.subject ?? '', ttlSeconds: body?.ttlSeconds ?? 900 },
    );
    return { token: made.token, expiresAt: made.expiresAt.toISOString() };
  }
}
