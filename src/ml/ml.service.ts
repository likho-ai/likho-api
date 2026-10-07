/**
 * Speech models, the gold set, evaluations and training data: all kept by likho-ml. This asks it
 * for the workspace of the signed-in person, and passes a recording's audio (which only likho-api
 * knows) when it joins the gold set.
 */
import { Injectable } from '@nestjs/common';
import { Code, ConnectError } from '@connectrpc/connect';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { invalid } from '../common/errors.js';
import { RecordingsService } from '../recordings/recordings.service.js';
import {
  type Evaluation,
  evaluationFromPb,
  type GoldItem,
  goldFromPb,
  type GoldSet,
  modelFromPb,
  type RegisterSpeechModelInput,
  type SpeechModel,
  type TrainingStats,
} from './ml.graphql.js';

@Injectable()
export class MlService {
  constructor(
    private readonly clients: Clients,
    private readonly recordings: RecordingsService,
  ) {}

  private async call<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.AlreadyExists) throw invalid(error.rawMessage);
      throw fromRpc(error, 'model');
    }
  }

  async models(includeRetired: boolean): Promise<SpeechModel[]> {
    const reply = await this.call(() => this.clients.ml.listModels({ includeRetired }));
    return reply.models.map(modelFromPb);
  }

  async register(input: RegisterSpeechModelInput, userId: string): Promise<SpeechModel> {
    const reply = await this.call(() =>
      this.clients.ml.registerModel({
        registryId: input.registryId,
        description: input.description ?? '',
        languages: input.languages ?? [],
        artifactUri: input.artifactUri ?? '',
        baseModelId: input.baseModelId ?? '',
        userId,
      }),
    );
    return modelFromPb(reply.model!);
  }

  async setDefault(modelId: string, userId: string): Promise<SpeechModel> {
    const reply = await this.call(() => this.clients.ml.setDefault({ modelId, userId }));
    return modelFromPb(reply.model!);
  }

  async retire(modelId: string, userId: string): Promise<SpeechModel> {
    const reply = await this.call(() => this.clients.ml.retireModel({ modelId, userId }));
    return modelFromPb(reply.model!);
  }

  async goldSet(workspaceId: string): Promise<GoldSet> {
    const reply = await this.call(() => this.clients.ml.listGoldSet({ workspaceId }));
    return { items: reply.items.map(goldFromPb), audioSeconds: reply.audioSeconds };
  }

  /** Adds a recording with its latest transcript as the reference (a person checked it line by line). */
  async addToGoldSet(workspaceId: string, recordingId: string, userId: string): Promise<GoldItem> {
    const recording = await this.recordings.get(workspaceId, recordingId);
    if (!recording.latestTranscriptId) throw invalid('The recording has no transcript yet.');
    const reply = await this.call(() =>
      this.clients.ml.addToGoldSet({
        workspaceId,
        recordingId,
        transcriptId: recording.latestTranscriptId!,
        mediaId: recording.mediaId,
        userId,
      }),
    );
    return goldFromPb(reply.item!);
  }

  async removeFromGoldSet(workspaceId: string, recordingId: string, userId: string): Promise<void> {
    await this.call(() => this.clients.ml.removeFromGoldSet({ workspaceId, recordingId, userId }));
  }

  async startEvaluation(workspaceId: string, modelId: string, userId: string): Promise<Evaluation> {
    const reply = await this.call(() => this.clients.ml.startEvaluation({ workspaceId, modelId, userId }));
    return evaluationFromPb(reply.evaluation!);
  }

  /** One evaluation with its recordings; only the workspace's own. */
  async evaluation(workspaceId: string, evaluationId: string): Promise<Evaluation> {
    const reply = await this.call(() => this.clients.ml.getEvaluation({ evaluationId }));
    if (reply.evaluation?.workspaceId !== workspaceId) {
      throw fromRpc(new ConnectError('no such evaluation', Code.NotFound), 'model');
    }
    return evaluationFromPb(reply.evaluation);
  }

  async evaluations(workspaceId: string, modelId: string | undefined, limit: number): Promise<Evaluation[]> {
    const reply = await this.call(() =>
      this.clients.ml.listEvaluations({ workspaceId, modelId: modelId ?? '', limit }),
    );
    return reply.evaluations.map(evaluationFromPb);
  }

  async trainingStats(workspaceId: string): Promise<TrainingStats> {
    const s = await this.call(() => this.clients.ml.getTrainingStats({ workspaceId }));
    return {
      examples: s.examples,
      scriptExamples: s.scriptExamples,
      romanExamples: s.romanExamples,
      recordings: s.recordings,
      audioSeconds: s.audioSeconds,
      lastExampleAt: s.lastExampleAt?.seconds ? new Date(Number(s.lastExampleAt.seconds) * 1000) : null,
    };
  }
}
