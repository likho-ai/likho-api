import { Args, Field, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { forbidden } from '../common/errors.js';
import { RecordingsService } from '../recordings/recordings.service.js';
import { Transcript, transcriptFromPb } from './transcripts.graphql.js';

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
    try {
      const reply = await this.clients.transcription.retransliterate({ transcriptId });
      const rebuilt = transcriptFromPb(reply.transcript!);
      await this.recordings.setRecordingStatus(existing.recordingId, 'done', {
        latestTranscriptId: rebuilt.id,
      });
      return rebuilt;
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
