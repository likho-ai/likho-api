/**
 * The REST API for scripts and connectors, with an API key. The same operations as GraphQL,
 * for callers that do not want a GraphQL client. Documented at /api/docs (OpenAPI).
 */
import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { invalid } from '../common/errors.js';
import {
  IMPORT_STATUSES,
  type ImportStatus,
  RECORDING_STATUSES,
  type RecordingStatus,
} from '../db/schema.js';
import { type ImportRow, ImportsService } from '../imports/imports.service.js';
import { SearchService } from '../search/search.service.js';
import { type JobRow, type RecordingRow, RecordingsService } from '../recordings/recordings.service.js';
import {
  correctionFromPb,
  type Layer,
  layerToPb,
  transcriptFromPb,
} from '../transcripts/transcripts.graphql.js';

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
  @ApiPropertyOptional({
    description: 'Where the call comes from: a connector’s name, e.g. ameyo.',
    example: 'ameyo',
  })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_-]{0,31}$/)
  source?: string;
  @ApiPropertyOptional({
    description: 'Facts about the call: campaign, agent, disposition, call time, ...',
    example: { campaign: 'inbound', agent: 'agent-12', disposition: 'sale' },
  })
  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;
}

export class CorrectSegmentDto {
  @ApiProperty({ description: 'The version being looked at; it must be the latest.' })
  @IsString()
  transcriptId: string;
  @ApiProperty({ example: 3 }) @IsInt() @Min(0) segmentIndex: number;
  @ApiProperty({
    enum: ['script', 'roman'],
    description: 'script: as spoken, in its script. roman: the Hinglish.',
  })
  @IsIn(['script', 'roman'])
  layer: Layer;
  @ApiProperty({ description: 'What the line should read.' }) @IsString() @MaxLength(2000) text: string;
}

export class SearchQueryDto {
  @ApiProperty({ description: 'A few words, in either layer; typos allowed.', example: 'order confirm' })
  @IsString()
  @MaxLength(200)
  q: string;
  @ApiPropertyOptional({ description: 'A detected language (ISO 639-1).' })
  @IsOptional()
  @IsString()
  language?: string;
  @ApiPropertyOptional({ description: 'Only this recording.' })
  @IsOptional()
  @IsString()
  recordingId?: string;
  @ApiPropertyOptional({ description: 'Transcripts created from this moment (ISO 8601).' })
  @IsOptional()
  @IsString()
  since?: string;
  @ApiPropertyOptional({ description: 'Transcripts created up to this moment (ISO 8601).' })
  @IsOptional()
  @IsString()
  until?: string;
  @ApiPropertyOptional({ default: 1 }) @IsOptional() @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class RequestImportDto {
  @ApiProperty({
    description: 'The call’s id in the dialer (its crt_object_id).',
    example: 'd000-0a1b2c3d-vce-0001',
  })
  @IsString()
  @MaxLength(200)
  externalId: string;
  @ApiPropertyOptional({ description: 'Which connector; empty = the default one.' })
  @IsOptional()
  @IsString()
  source?: string;
  @ApiPropertyOptional({ description: 'Transcribe once stored (default true).' })
  @IsOptional()
  @IsBoolean()
  transcribe?: boolean;
}

export class ListImportsQuery {
  @ApiPropertyOptional({ enum: IMPORT_STATUSES }) @IsOptional() @IsIn(IMPORT_STATUSES) status?: ImportStatus;
  @ApiPropertyOptional({ description: 'The id of the last import of the previous page.' })
  @IsOptional()
  @IsString()
  after?: string;
  @ApiPropertyOptional({ default: 50 }) @IsOptional() @IsInt() @Min(1) first?: number;
}

const importJson = (i: ImportRow) => ({
  ...i,
  createdAt: i.createdAt.toISOString(),
  updatedAt: i.updatedAt.toISOString(),
});

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
    private readonly audit: AuditService,
  ) {}

  @Post()
  @MinRole('member')
  @ApiOperation({
    summary: 'Start an upload',
    description: 'Makes the recording and returns the link to PUT the file to.',
  })
  async requestUpload(@CurrentUser() me: Principal, @Body() body: RequestUploadDto) {
    const { source, ...rest } = body;
    const answer = await this.recordings.requestUpload(me.workspaceId, me.userId, {
      ...rest,
      source: me.kind === 'api_key' ? source || 'api' : 'upload',
    });
    if (!answer.duplicateOf) {
      await this.audit.record(
        me,
        'recording.created',
        { kind: 'recording', id: answer.recording.id },
        {
          originalName: answer.recording.originalName,
          source: answer.recording.source,
        },
      );
    }
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
  @MinRole('member')
  @ApiOperation({ summary: 'Delete a recording, its audio and its jobs' })
  async delete(@CurrentUser() me: Principal, @Param('id') id: string) {
    const recording = await this.recordings.get(me.workspaceId, id);
    await this.recordings.delete(me.workspaceId, id);
    await this.audit.record(
      me,
      'recording.deleted',
      { kind: 'recording', id },
      { originalName: recording.originalName },
    );
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

  @Post(':id/transcript/corrections')
  @MinRole('member')
  @ApiOperation({
    summary: 'Correct one line',
    description:
      'Replaces one line with what you wrote: a new version of the transcript, the correction kept. The Hinglish of a corrected script line is derived again.',
  })
  async correct(@CurrentUser() me: Principal, @Param('id') id: string, @Body() body: CorrectSegmentDto) {
    const recording = await this.recordings.get(me.workspaceId, id);
    if (recording.latestTranscriptId !== body.transcriptId)
      throw invalid('Correct the latest version of the transcript.');
    const text = body.text.trim();
    if (!text) throw invalid('The corrected line is empty.');
    let reply;
    try {
      reply = await this.clients.transcription.correctSegment({
        transcriptId: body.transcriptId,
        segmentIndex: body.segmentIndex,
        layer: layerToPb(body.layer),
        text,
        userId: me.userId ?? '',
        workspaceId: me.workspaceId,
      });
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
    const corrected = transcriptFromPb(reply.transcript!);
    await this.recordings.setRecordingStatus(id, 'done', { latestTranscriptId: corrected.id });
    await this.audit.record(
      me,
      'transcript.corrected',
      { kind: 'recording', id },
      {
        from: body.transcriptId,
        to: corrected.id,
        segmentIndex: body.segmentIndex,
        layer: body.layer,
      },
    );
    return { transcript: corrected, correction: correctionFromPb(reply.correction!) };
  }

  @Get(':id/transcript/corrections')
  @ApiOperation({ summary: 'The corrections made to a recording', description: 'Newest first.' })
  async corrections(@CurrentUser() me: Principal, @Param('id') id: string) {
    await this.recordings.get(me.workspaceId, id);
    try {
      const reply = await this.clients.transcription.listCorrections({ recordingId: id });
      return { items: reply.corrections.map(correctionFromPb) };
    } catch (error) {
      throw fromRpc(error, 'transcription');
    }
  }

  @Post(':id/jobs')
  @MinRole('member')
  @ApiOperation({ summary: 'Queue a transcription' })
  async createJob(@CurrentUser() me: Principal, @Param('id') id: string, @Body() body: CreateJobDto) {
    const job = await this.recordings.createJob(me.workspaceId, me.userId, id, body);
    await this.audit.record(
      me,
      'job.created',
      { kind: 'job', id: job.id },
      {
        recordingId: id,
        languagePolicy: job.languagePolicy,
        force: job.force,
      },
    );
    return jobJson(job);
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
  constructor(
    private readonly recordings: RecordingsService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'One job' })
  async get(@CurrentUser() me: Principal, @Param('id') id: string) {
    return jobJson(await this.recordings.getJob(me.workspaceId, id));
  }

  @Post(':id/cancel')
  @MinRole('member')
  @ApiOperation({ summary: 'Stop a waiting or running job' })
  async cancel(@CurrentUser() me: Principal, @Param('id') id: string) {
    const job = await this.recordings.cancelJob(me.workspaceId, id);
    await this.audit.record(me, 'job.cancelled', { kind: 'job', id }, { recordingId: job.recordingId });
    return jobJson(job);
  }
}

const parseMoment = (value: string | undefined, name: string): Date | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid(`${name} must be a date and time (ISO 8601).`);
  return date;
};

@ApiTags('search')
@ApiBearerAuth()
@Controller('api/v1/search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({
    summary: 'Search every transcript line',
    description: 'A few words in either layer, typos allowed; the matches are inside <mark>…</mark>.',
  })
  async find(@CurrentUser() me: Principal, @Query() query: SearchQueryDto) {
    const page = await this.search.search(me.workspaceId, {
      query: query.q,
      language: query.language,
      recordingId: query.recordingId,
      since: parseMoment(query.since, 'since'),
      until: parseMoment(query.until, 'until'),
      page: query.page,
      pageSize: query.pageSize,
    });
    return {
      ...page,
      hits: page.hits.map((hit) => ({ ...hit, recording: recordingJson(hit.recording) })),
    };
  }
}

@ApiTags('imports')
@ApiBearerAuth()
@Controller('api/v1/imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @MinRole('member')
  @ApiOperation({
    summary: 'Fetch a call from the dialer by its id',
    description: 'The connector fetches the call; poll the import, or the recordings, to see it arrive.',
  })
  async request(@CurrentUser() me: Principal, @Body() body: RequestImportDto) {
    const row = await this.imports.request(me.workspaceId, me.userId, body);
    await this.audit.record(
      me,
      'import.requested',
      { kind: 'import', id: row.id },
      {
        source: row.source,
        externalId: row.externalId,
      },
    );
    return importJson(row);
  }

  @Get()
  @ApiOperation({ summary: 'List imports', description: 'Newest first.' })
  async list(@CurrentUser() me: Principal, @Query() query: ListImportsQuery) {
    const page = await this.imports.list(me.workspaceId, {
      status: query.status ? [query.status] : undefined,
      after: query.after,
      limit: query.first,
    });
    return { items: page.items.map(importJson), hasMore: page.hasMore };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One import' })
  async get(@CurrentUser() me: Principal, @Param('id') id: string) {
    return importJson(await this.imports.get(me.workspaceId, id));
  }
}
