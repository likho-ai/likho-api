import { Args, Int, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Transcript, transcriptFromPb } from '../transcripts/transcripts.graphql.js';
import {
  Attribute,
  attributeList,
  CreateJobInput,
  Job,
  JobStatusEnum,
  Recording,
  RecordingCounts,
  RecordingFilter,
  RecordingPage,
  RequestUploadInput,
  UploadTicket,
} from './recordings.graphql.js';
import { type RecordingRow, RecordingsService } from './recordings.service.js';

@Resolver(() => Recording)
export class RecordingsResolver {
  constructor(
    private readonly service: RecordingsService,
    private readonly clients: Clients,
  ) {}

  @Query(() => RecordingPage, { description: 'The workspace’s recordings, newest first.' })
  async recordings(
    @CurrentUser() me: Principal,
    @Args('filter', { nullable: true }) filter?: RecordingFilter,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
    @Args('after', { nullable: true }) after?: string,
  ): Promise<RecordingPage> {
    const page = await this.service.list(me.workspaceId, {
      status: filter?.status,
      search: filter?.search,
      after: after ?? undefined,
      limit: first ?? undefined,
    });
    return { items: page.items, hasMore: page.hasMore, endCursor: page.items.at(-1)?.id ?? null };
  }

  @Query(() => Recording)
  async recording(@CurrentUser() me: Principal, @Args('id') id: string): Promise<Recording> {
    return this.service.get(me.workspaceId, id);
  }

  @Query(() => RecordingCounts, { description: 'How many recordings are in each state.' })
  async recordingCounts(@CurrentUser() me: Principal): Promise<RecordingCounts> {
    return this.service.counts(me.workspaceId);
  }

  @Mutation(() => UploadTicket, {
    description: 'Starts an upload: makes the recording and returns where to PUT the file.',
  })
  async requestUpload(
    @CurrentUser() me: Principal,
    @Args('input') input: RequestUploadInput,
  ): Promise<UploadTicket> {
    const { attributes, source, ...rest } = input;
    return this.service.requestUpload(me.workspaceId, me.userId, {
      ...rest,
      // A person uploads; a script is 'api' unless it says which connector it is.
      source: me.kind === 'api_key' ? source?.trim() || 'api' : 'upload',
      attributes: Object.fromEntries((attributes ?? []).map((a) => [a.key, a.value])),
    });
  }

  @Mutation(() => Boolean, { description: 'Removes the recording, its audio and its jobs.' })
  async deleteRecording(@CurrentUser() me: Principal, @Args('id') id: string): Promise<boolean> {
    await this.service.delete(me.workspaceId, id);
    return true;
  }

  @ResolveField(() => String, {
    nullable: true,
    description: 'A short-lived link to the audio a browser plays.',
  })
  async playbackUrl(@Parent() recording: RecordingRow): Promise<string | null> {
    if (!['ready', 'queued', 'transcribing', 'done'].includes(recording.status)) return null;
    return this.service.downloadUrl(recording, 'audio');
  }

  @ResolveField(() => String, { nullable: true, description: 'A short-lived link to the waveform (JSON).' })
  async peaksUrl(@Parent() recording: RecordingRow): Promise<string | null> {
    if (!['ready', 'queued', 'transcribing', 'done'].includes(recording.status)) return null;
    return this.service.downloadUrl(recording, 'peaks');
  }

  @ResolveField(() => [Attribute], { description: 'Facts about the call from where it came.' })
  attributes(@Parent() recording: RecordingRow): Attribute[] {
    return attributeList(recording.attributes);
  }

  @ResolveField(() => [Job], { description: 'The jobs of this recording, newest first.' })
  async jobs(@Parent() recording: RecordingRow): Promise<Job[]> {
    return this.service.listJobs(recording.workspaceId, recording.id);
  }

  @ResolveField(() => Transcript, { nullable: true, description: 'The newest transcript, with every line.' })
  async latestTranscript(@Parent() recording: RecordingRow): Promise<Transcript | null> {
    if (!recording.latestTranscriptId) return null;
    try {
      const reply = await this.clients.transcription.getTranscript({ id: recording.latestTranscriptId });
      return reply.transcript ? transcriptFromPb(reply.transcript) : null;
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
  }
}

@Resolver(() => Job)
export class JobsResolver {
  constructor(private readonly service: RecordingsService) {}

  @Query(() => [Job], { description: 'Jobs of the workspace, newest first.' })
  async jobs(
    @CurrentUser() me: Principal,
    @Args('recordingId', { nullable: true }) recordingId?: string,
    @Args('status', { type: () => [JobStatusEnum], nullable: true }) status?: (keyof typeof JobStatusEnum)[],
  ): Promise<Job[]> {
    return this.service.listJobs(me.workspaceId, recordingId ?? undefined, status);
  }

  @Query(() => Job)
  async job(@CurrentUser() me: Principal, @Args('id') id: string): Promise<Job> {
    return this.service.getJob(me.workspaceId, id);
  }

  @Mutation(() => Job, { description: 'Queues a transcription of a recording.' })
  async createJob(@CurrentUser() me: Principal, @Args('input') input: CreateJobInput): Promise<Job> {
    return this.service.createJob(me.workspaceId, me.userId, input.recordingId, input);
  }

  @Mutation(() => Job, { description: 'Stops a waiting or running job.' })
  async cancelJob(@CurrentUser() me: Principal, @Args('id') id: string): Promise<Job> {
    return this.service.cancelJob(me.workspaceId, id);
  }
}
