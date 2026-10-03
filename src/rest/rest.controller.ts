/**
 * The REST API for scripts and connectors, with an API key. The same operations as GraphQL,
 * for callers that do not want a GraphQL client. Documented at /api/docs (OpenAPI).
 */
import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { RECORDING_STATUSES, type RecordingStatus } from '../db/schema.js';
import { type JobRow, type RecordingRow, RecordingsService } from '../recordings/recordings.service.js';
import { transcriptFromPb } from '../transcripts/transcripts.graphql.js';

export class RequestUploadDto {
  @ApiProperty({ example: 'call-2026-10-01-0912.mp3' }) @IsString() @MaxLength(255) originalName: string;
  @ApiProperty({ example: 105_000 }) @IsInt() @Min(0) sizeBytes: number;
  @ApiPropertyOptional({ example: 'audio/mpeg' }) @IsOptional() @IsString() contentType?: string;
  @ApiPropertyOptional({ description: 'When known, the same content is not uploaded twice.' })
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  sha256?: string;
  @ApiPropertyOptional({ description: 'Your own id for the call.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalId?: string;
}

export class CreateJobDto {
  @ApiPropertyOptional({ description: 'Empty = the default model.' })
  @IsOptional()
  @IsString()
  modelRegistryId?: string;
  @ApiPropertyOptional({ description: '"auto" or a language code.', example: 'auto' })
  @IsOptional()
  @IsString()
  languagePolicy?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() force?: boolean;
}

export class ListRecordingsQuery {
  @ApiPropertyOptional({ enum: RECORDING_STATUSES })
  @IsOptional()
  @IsIn(RECORDING_STATUSES)
  status?: RecordingStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional({ description: 'The id of the last recording of the previous page.' })
  @IsOptional()
  @IsString()
  after?: string;
  @ApiPropertyOptional({ default: 50 }) @IsOptional() @IsInt() @Min(1) first?: number;
}

const recordingJson = (r: RecordingRow) => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
const jobJson = (j: JobRow) => ({
  ...j,
  createdAt: j.createdAt.toISOString(),
  startedAt: j.startedAt?.toISOString() ?? null,
  finishedAt: j.finishedAt?.toISOString() ?? null,
});

@ApiTags('recordings')
@ApiBearerAuth()
@Controller('api/v1/recordings')
export class RecordingsController {
  constructor(
    private readonly recordings: RecordingsService,
    private readonly clients: Clients,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Start an upload',
    description: 'Makes the recording and returns the link to PUT the file to.',
  })
  async requestUpload(@CurrentUser() me: Principal, @Body() body: RequestUploadDto) {
    const answer = await this.recordings.requestUpload(me.workspaceId, me.userId, {
      ...body,
      source: me.kind === 'api_key' ? 'api' : 'upload',
    });
    return {
      recording: recordingJson(answer.recording),
      uploadUrl: answer.uploadUrl,
      expiresAt: answer.expiresAt?.toISOString() ?? null,
      duplicateOf: answer.duplicateOf ? recordingJson(answer.duplicateOf) : null,
    };
  }

  @Get()
  @ApiOperation({ summary: 'List recordings', description: 'Newest first.' })
  async list(@CurrentUser() me: Principal, @Query() query: ListRecordingsQuery) {
    const page = await this.recordings.list(me.workspaceId, {
      status: query.status ? [query.status] : undefined,
      search: query.search,
      after: query.after,
      limit: query.first,
    });
    return {
      items: page.items.map(recordingJson),
      hasMore: page.hasMore,
      endCursor: page.items.at(-1)?.id ?? null,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One recording' })
  async get(@CurrentUser() me: Principal, @Param('id') id: string) {
    return recordingJson(await this.recordings.get(me.workspaceId, id));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a recording, its audio and its jobs' })
  async delete(@CurrentUser() me: Principal, @Param('id') id: string) {
    await this.recordings.delete(me.workspaceId, id);
    return { deleted: true };
  }

  @Get(':id/audio')
  @ApiOperation({ summary: 'A short-lived link to the audio a browser plays' })
  async audio(@CurrentUser() me: Principal, @Param('id') id: string) {
    const recording = await this.recordings.get(me.workspaceId, id);
    return { url: await this.recordings.downloadUrl(recording, 'audio') };
  }

  @Get(':id/transcript')
  @ApiOperation({
    summary: 'The newest transcript',
    description: 'Every line with both layers: as spoken, and Hinglish.',
  })
  async transcript(@CurrentUser() me: Principal, @Param('id') id: string) {
    const recording = await this.recordings.get(me.workspaceId, id);
    if (!recording.latestTranscriptId) return { transcript: null, status: recording.status };
    try {
      const reply = await this.clients.transcription.getTranscript({ id: recording.latestTranscriptId });
      return { transcript: transcriptFromPb(reply.transcript!), status: recording.status };
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
  }

  @Post(':id/jobs')
  @ApiOperation({ summary: 'Queue a transcription' })
  async createJob(@CurrentUser() me: Principal, @Param('id') id: string, @Body() body: CreateJobDto) {
    return jobJson(await this.recordings.createJob(me.workspaceId, me.userId, id, body));
  }

  @Get(':id/jobs')
  @ApiOperation({ summary: 'The jobs of a recording, newest first' })
  async jobs(@CurrentUser() me: Principal, @Param('id') id: string) {
    await this.recordings.get(me.workspaceId, id);
    return { items: (await this.recordings.listJobs(me.workspaceId, id)).map(jobJson) };
  }
}

@ApiTags('jobs')
@ApiBearerAuth()
@Controller('api/v1/jobs')
export class JobsController {
  constructor(private readonly recordings: RecordingsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'One job' })
  async get(@CurrentUser() me: Principal, @Param('id') id: string) {
    return jobJson(await this.recordings.getJob(me.workspaceId, id));
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Stop a waiting or running job' })
  async cancel(@CurrentUser() me: Principal, @Param('id') id: string) {
    return jobJson(await this.recordings.cancelJob(me.workspaceId, id));
  }
}
