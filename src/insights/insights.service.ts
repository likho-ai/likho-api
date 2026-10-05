/**
 * Insights: what likho-insights says about a recording's transcript. The insights themselves
 * live there; this reads them for the workspace that owns the recording, and asks for them.
 */
import { Injectable } from '@nestjs/common';
import { Code, ConnectError } from '@connectrpc/connect';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { invalid } from '../common/errors.js';
import { type RecordingRow, RecordingsService } from '../recordings/recordings.service.js';
import { Insights, insightsFromPb, InsightsStatus } from './insights.graphql.js';

@Injectable()
export class InsightsService {
  constructor(
    private readonly clients: Clients,
    private readonly recordings: RecordingsService,
  ) {}

  /** The newest insights of a recording, or null when it has none yet. */
  async forRecording(workspaceId: string, recordingId: string): Promise<Insights | null> {
    return this.forRow(await this.recordings.get(workspaceId, recordingId));
  }

  async forRow(recording: RecordingRow): Promise<Insights | null> {
    if (!recording.latestTranscriptId) return null;
    try {
      const reply = await this.clients.insights.getInsights({ recordingId: recording.id });
      return reply.insights ? insightsFromPb(reply.insights) : null;
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.NotFound) return null;
      throw fromRpc(error, 'insights');
    }
  }

  /** Asks for the insights of the recording's latest transcript now (again, with force). */
  async analyse(workspaceId: string, recordingId: string, force: boolean): Promise<Insights> {
    const recording = await this.recordings.get(workspaceId, recordingId);
    if (!recording.latestTranscriptId) throw invalid('The recording has no transcript yet.');
    try {
      const reply = await this.clients.insights.analyse({
        transcriptId: recording.latestTranscriptId,
        workspaceId,
        force,
      });
      if (!reply.insights) throw new ConnectError('no insights came back', Code.Internal);
      return insightsFromPb(reply.insights);
    } catch (error) {
      throw fromRpc(error, 'insights');
    }
  }

  async status(): Promise<InsightsStatus> {
    try {
      const reply = await this.clients.insights.getStatus({});
      return { enabled: reply.enabled, model: reply.model, formVersion: reply.formVersion };
    } catch (error) {
      throw fromRpc(error, 'insights');
    }
  }
}
