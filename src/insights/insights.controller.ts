/** Insights over REST, for scripts and the company's own systems. */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { notFound } from '../common/errors.js';
import { insightsJson } from './insights.graphql.js';
import { InsightsService } from './insights.service.js';

export class AnalyseDto {
  @ApiProperty({ required: false, description: 'Analyse again even when the recording has insights.' })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

@ApiTags('insights')
@ApiBearerAuth()
@Controller('api/v1')
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly audit: AuditService,
  ) {}

  @Get('recordings/:id/insights')
  @ApiOperation({
    summary: 'The insights of a recording',
    description:
      'The summary, the products, the customer’s mood and the auditor’s form pre-filled, for the recording’s latest analysed transcript. 404 while it has none.',
  })
  async get(@CurrentUser() me: Principal, @Param('id') id: string) {
    const insights = await this.insights.forRecording(me.workspaceId, id);
    if (!insights) throw notFound('insights for this recording');
    return insightsJson(insights);
  }

  @Post('recordings/:id/insights')
  @MinRole('member')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Analyse a recording now',
    description: 'Asks the model about the recording’s latest transcript and answers with the insights.',
  })
  async analyse(@CurrentUser() me: Principal, @Param('id') id: string, @Body() body: AnalyseDto) {
    const force = Boolean(body?.force);
    const insights = await this.insights.analyse(me.workspaceId, id, force);
    await this.audit.record(
      me,
      'insights.requested',
      { kind: 'recording', id },
      { transcriptId: insights.transcriptId, force, model: insights.model },
    );
    return insightsJson(insights);
  }

  @Get('insights/status')
  @ApiOperation({
    summary: 'Whether insights are made at all',
    description:
      'enabled is false when no model is configured: nothing is analysed and no transcript text leaves.',
  })
  status() {
    return this.insights.status();
  }
}
