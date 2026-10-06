/** What the dialer knows about its calls, over REST, for scripts. */
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { DialerService } from './dialer.service.js';

class WindowQuery {
  @ApiProperty({ description: 'The start of the window of call time (ISO 8601), included.' })
  @IsISO8601()
  since: string;

  @ApiProperty({ description: 'The end of the window (ISO 8601), not included.' })
  @IsISO8601()
  until: string;
}

class AgentsQuery extends WindowQuery {
  @ApiProperty({ required: false }) @IsOptional() @IsString() campaign?: string;
}

class CallsQuery extends WindowQuery {
  @ApiProperty({ required: false }) @IsOptional() @IsString() campaign?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() agent?: string;
  @ApiProperty({ required: false, description: 'Only calls that connected (default true).' })
  @IsOptional()
  // The raw query text: implicit conversion would read any non-empty text, "false" too, as true.
  @Transform(({ obj, key }) => {
    const raw = (obj as Record<string, unknown>)[key];
    return typeof raw === 'string' ? !['false', '0', 'no', 'off'].includes(raw.toLowerCase()) : raw;
  })
  @IsBoolean()
  connectedOnly?: boolean;
  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minTalkSeconds?: number;
  @ApiProperty({ required: false, description: 'The nextCursor of the previous page.' })
  @IsOptional()
  @IsString()
  after?: string;
  @ApiProperty({ required: false, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  first?: number;
}

@ApiTags('dialer')
@ApiBearerAuth()
@Controller('api/v1/dialer')
export class DialerController {
  constructor(private readonly dialer: DialerService) {}

  @Get('campaigns')
  @ApiOperation({ summary: 'The dialer’s campaigns of a window, with their counts' })
  campaigns(@Query() q: WindowQuery) {
    return this.dialer.campaigns({ since: new Date(q.since), until: new Date(q.until) });
  }

  @Get('agents')
  @ApiOperation({ summary: 'The dialer’s agents of a window' })
  agents(@Query() q: AgentsQuery) {
    return this.dialer.agents({ since: new Date(q.since), until: new Date(q.until) }, q.campaign ?? '');
  }

  @Get('calls')
  @ApiOperation({ summary: 'The dialer’s calls of a window, newest first, a page at a time' })
  calls(@CurrentUser() me: Principal, @Query() q: CallsQuery) {
    return this.dialer.calls(
      me.workspaceId,
      {
        since: new Date(q.since),
        until: new Date(q.until),
        campaign: q.campaign,
        agent: q.agent,
        connectedOnly: q.connectedOnly,
        minTalkSeconds: q.minTalkSeconds,
      },
      q.first ?? 50,
      q.after ?? '',
    );
  }

  @Get('status')
  @ApiOperation({ summary: 'What the dialer connector is doing' })
  status() {
    return this.dialer.status();
  }
}
