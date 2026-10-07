import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuditService } from '../audit/audit.service.js';
import { AdminOnly, CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import {
  Evaluation,
  GoldItem,
  GoldSet,
  RegisterSpeechModelInput,
  SpeechModel,
  TrainingStats,
} from './ml.graphql.js';
import { MlService } from './ml.service.js';

@Resolver()
export class MlResolver {
  constructor(
    private readonly ml: MlService,
    private readonly audit: AuditService,
  ) {}

  @MinRole('member')
  @Query(() => [SpeechModel], {
    description: 'The speech models, the default first, with their latest scores.',
  })
  async speechModels(
    @Args('includeRetired', { nullable: true }) includeRetired?: boolean,
  ): Promise<SpeechModel[]> {
    return this.ml.models(Boolean(includeRetired));
  }

  @MinRole('member')
  @Query(() => GoldSet, {
    description: 'The workspace’s gold set: recordings whose transcript is the reference.',
  })
  async goldSet(@CurrentUser() me: Principal): Promise<GoldSet> {
    return this.ml.goldSet(me.workspaceId);
  }

  @MinRole('member')
  @Query(() => [Evaluation], {
    description: 'The workspace’s evaluations, newest first (without their recordings).',
  })
  async evaluations(
    @CurrentUser() me: Principal,
    @Args('modelId', { nullable: true }) modelId?: string,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
  ): Promise<Evaluation[]> {
    return this.ml.evaluations(me.workspaceId, modelId, first ?? 50);
  }

  @MinRole('member')
  @Query(() => Evaluation, { description: 'One evaluation, with each recording’s scores.' })
  async evaluation(@CurrentUser() me: Principal, @Args('id') id: string): Promise<Evaluation> {
    return this.ml.evaluation(me.workspaceId, id);
  }

  @MinRole('member')
  @Query(() => TrainingStats, { description: 'What people’s corrections have given as training data.' })
  async trainingStats(@CurrentUser() me: Principal): Promise<TrainingStats> {
    return this.ml.trainingStats(me.workspaceId);
  }

  @AdminOnly()
  @Mutation(() => SpeechModel, {
    description: 'Adds a model to the registry (a fine-tuned one, or another size).',
  })
  async registerSpeechModel(
    @CurrentUser() me: Principal,
    @Args('input') input: RegisterSpeechModelInput,
  ): Promise<SpeechModel> {
    const model = await this.ml.register(input, me.userId ?? '');
    await this.audit.record(
      me,
      'model.registered',
      { kind: 'model', id: model.id },
      { registryId: model.registryId },
    );
    return model;
  }

  @AdminOnly()
  @Mutation(() => SpeechModel, { description: 'Makes a model the one new transcriptions use.' })
  async setDefaultSpeechModel(@CurrentUser() me: Principal, @Args('id') id: string): Promise<SpeechModel> {
    const model = await this.ml.setDefault(id, me.userId ?? '');
    await this.audit.record(me, 'model.chosen', { kind: 'model', id }, { registryId: model.registryId });
    return model;
  }

  @AdminOnly()
  @Mutation(() => SpeechModel, { description: 'Retires a model: kept for history, never the default.' })
  async retireSpeechModel(@CurrentUser() me: Principal, @Args('id') id: string): Promise<SpeechModel> {
    const model = await this.ml.retire(id, me.userId ?? '');
    await this.audit.record(me, 'model.retired', { kind: 'model', id }, { registryId: model.registryId });
    return model;
  }

  @AdminOnly()
  @Mutation(() => GoldItem, {
    description:
      'Adds a recording to the gold set; its latest transcript (checked line by line) is the reference.',
  })
  async addToGoldSet(
    @CurrentUser() me: Principal,
    @Args('recordingId') recordingId: string,
  ): Promise<GoldItem> {
    const item = await this.ml.addToGoldSet(me.workspaceId, recordingId, me.userId ?? '');
    await this.audit.record(
      me,
      'gold.added',
      { kind: 'recording', id: recordingId },
      { transcriptId: item.transcriptId, version: item.transcriptVersion },
    );
    return item;
  }

  @AdminOnly()
  @Mutation(() => Boolean)
  async removeFromGoldSet(
    @CurrentUser() me: Principal,
    @Args('recordingId') recordingId: string,
  ): Promise<boolean> {
    await this.ml.removeFromGoldSet(me.workspaceId, recordingId, me.userId ?? '');
    await this.audit.record(me, 'gold.removed', { kind: 'recording', id: recordingId });
    return true;
  }

  @AdminOnly()
  @Mutation(() => Evaluation, {
    description: 'Scores a model on the gold set; answers at once (queued), the scores follow.',
  })
  async startEvaluation(@CurrentUser() me: Principal, @Args('modelId') modelId: string): Promise<Evaluation> {
    const evaluation = await this.ml.startEvaluation(me.workspaceId, modelId, me.userId ?? '');
    await this.audit.record(
      me,
      'evaluation.started',
      { kind: 'evaluation', id: evaluation.id },
      { registryId: evaluation.registryId, recordings: evaluation.itemsTotal },
    );
    return evaluation;
  }
}
