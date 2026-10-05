import { Args, Field, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { forbidden, invalid } from '../common/errors.js';
import { RecordingsService } from '../recordings/recordings.service.js';
import {
  Correction,
  correctionFromPb,
  CorrectSegmentInput,
  layerToPb,
  Transcript,
  transcriptFromPb,
} from './transcripts.graphql.js';

@ObjectType()
export class Engine {
  @Field() registryId: string;
  @Field() engine: string;
  @Field() available: boolean;
  @Field() isDefault: boolean;
}

@Resolver()
export class TranscriptsResolver {
  constructor(
    private readonly clients: Clients,
    private readonly recordings: RecordingsService,
    private readonly audit: AuditService,
  ) {}

  /** A transcript belongs to a recording; only the recording's workspace may read it. */
  private async checked(me: Principal, transcriptId: string): Promise<Transcript> {
    let transcript: Transcript;
    try {
      const reply = await this.clients.transcription.getTranscript({ id: transcriptId });
      transcript = transcriptFromPb(reply.transcript!);
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
    await this.recordings.get(me.workspaceId, transcript.recordingId); // not found when it is another workspace's
    return transcript;
  }

  @Query(() => Transcript, { description: 'One transcript with every line, both layers.' })
  async transcript(@CurrentUser() me: Principal, @Args('id') id: string): Promise<Transcript> {
    return this.checked(me, id);
  }

  @Query(() => [Transcript], {
    description: 'Every version of a recording’s transcript, newest first, without lines.',
  })
  async transcriptVersions(
    @CurrentUser() me: Principal,
    @Args('recordingId') recordingId: string,
  ): Promise<Transcript[]> {
    await this.recordings.get(me.workspaceId, recordingId);
    try {
      const reply = await this.clients.transcription.listTranscripts({ recordingId });
      return reply.transcripts.map(transcriptFromPb);
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
  }

  @MinRole('member')
  @Mutation(() => Transcript, {
    description:
      'A new version whose Hinglish is rebuilt with the current spellings. The speech model does not run.',
  })
  async retransliterate(
    @CurrentUser() me: Principal,
    @Args('transcriptId') transcriptId: string,
  ): Promise<Transcript> {
    const existing = await this.checked(me, transcriptId);
    if (me.kind === 'api_key') throw forbidden('An API key cannot change transcripts.');
    let rebuilt: Transcript;
    try {
      const reply = await this.clients.transcription.retransliterate({ transcriptId });
      rebuilt = transcriptFromPb(reply.transcript!);
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
    await this.recordings.setRecordingStatus(existing.recordingId, 'done', {
      latestTranscriptId: rebuilt.id,
    });
    await this.audit.record(
      me,
      'transcript.retransliterated',
      { kind: 'recording', id: existing.recordingId },
      {
        from: transcriptId,
        to: rebuilt.id,
      },
    );
    return rebuilt;
  }

  @MinRole('member')
  @Mutation(() => Transcript, {
    description:
      'Replaces one line with what you wrote: a new version of the transcript, the correction kept. The Hinglish of a corrected script line is derived again.',
  })
  async correctSegment(
    @CurrentUser() me: Principal,
    @Args('input') input: CorrectSegmentInput,
  ): Promise<Transcript> {
    const existing = await this.checked(me, input.transcriptId);
    if (me.kind === 'api_key') throw forbidden('An API key cannot change transcripts.');
    const text = input.text.trim();
    if (!text) throw invalid('The corrected line is empty.');
    if (text.length > 2000) throw invalid('The corrected line is too long.');
    let corrected: Transcript;
    try {
      const reply = await this.clients.transcription.correctSegment({
        transcriptId: input.transcriptId,
        segmentIndex: input.segmentIndex,
        layer: layerToPb(input.layer),
        text,
        userId: me.userId ?? '',
        workspaceId: me.workspaceId,
      });
      corrected = transcriptFromPb(reply.transcript!);
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
    await this.recordings.setRecordingStatus(existing.recordingId, 'done', {
      latestTranscriptId: corrected.id,
    });
    await this.audit.record(
      me,
      'transcript.corrected',
      { kind: 'recording', id: existing.recordingId },
      {
        from: input.transcriptId,
        to: corrected.id,
        segmentIndex: input.segmentIndex,
        layer: input.layer,
      },
    );
    return corrected;
  }

  @Query(() => [Correction], {
    description: 'Every correction made to a recording’s transcripts, newest first.',
  })
  async corrections(
    @CurrentUser() me: Principal,
    @Args('recordingId') recordingId: string,
  ): Promise<Correction[]> {
    await this.recordings.get(me.workspaceId, recordingId);
    try {
      const reply = await this.clients.transcription.listCorrections({ recordingId });
      return reply.corrections.map(correctionFromPb);
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
  }

  @Query(() => [Engine], { description: 'The speech models a worker can run.' })
  async engines(): Promise<Engine[]> {
    try {
      const reply = await this.clients.transcription.listEngines({});
      return reply.engines.map((e) => ({
        registryId: e.registryId,
        engine: e.engine,
        available: e.available,
        isDefault: e.isDefault,
      }));
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
  }
}
