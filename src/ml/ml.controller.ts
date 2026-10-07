/** Speech models and evaluations over REST, for scripts. */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { AdminOnly, CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { json } from './ml.graphql.js';
import { MlService } from './ml.service.js';

export class StartEvaluationDto {
  @ApiProperty({ description: 'The model to score on the gold set.' })
  @IsString()
  modelId: string;
}

@ApiTags('models')
@ApiBearerAuth()
@Controller('api/v1')
export class MlController {
  constructor(
    private readonly ml: MlService,
    private readonly audit: AuditService,
  ) {}

  @Get('models')
  @MinRole('member')
  @ApiOperation({
    summary: 'The speech models',
    description: 'The default first, each with its latest scores.',
  })
  async models() {
    return json(await this.ml.models(false));
  }

  @Post('models/:id/default')
  @AdminOnly()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Make a model the default',
    description: 'New transcriptions use it from the next job.',
  })
  async setDefault(@CurrentUser() me: Principal, @Param('id') id: string) {
    const model = await this.ml.setDefault(id, me.userId ?? '');
    await this.audit.record(me, 'model.chosen', { kind: 'model', id }, { registryId: model.registryId });
    return json(model);
  }

  @Post('evaluations')
  @AdminOnly()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Score a model on the gold set',
    description: 'Answers at once with the queued evaluation; GET /api/v1/evaluations/:id follows it.',
  })
  async startEvaluation(@CurrentUser() me: Principal, @Body() body: StartEvaluationDto) {
    const evaluation = await this.ml.startEvaluation(me.workspaceId, body.modelId, me.userId ?? '');
    await this.audit.record(
      me,
      'evaluation.started',
      { kind: 'evaluation', id: evaluation.id },
      { registryId: evaluation.registryId, recordings: evaluation.itemsTotal },
    );
    return json(evaluation);
  }

  @Get('evaluations/:id')
  @MinRole('member')
  @ApiOperation({
    summary: 'An evaluation',
    description: 'Its status, scores, and each gold recording’s scores.',
  })
  async evaluation(@CurrentUser() me: Principal, @Param('id') id: string) {
    return json(await this.ml.evaluation(me.workspaceId, id));
  }

  @Get('training/stats')
  @MinRole('member')
  @ApiOperation({
    summary: 'Training data from corrections',
    description: 'Corrected lines, by layer, and the audio they cover.',
  })
  async trainingStats(@CurrentUser() me: Principal) {
    return json(await this.ml.trainingStats(me.workspaceId));
  }
}
