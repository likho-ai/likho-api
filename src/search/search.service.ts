/**
 * Search: asks likho-search for the lines and decorates each hit with its recording, so a person
 * sees the file name, the dialer id and the attributes beside the line.
 */
import { Injectable } from '@nestjs/common';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { invalid } from '../common/errors.js';
import { type RecordingRow, RecordingsService } from '../recordings/recordings.service.js';

export interface SearchQuery {
  query: string;
  language?: string;
  recordingId?: string;
  since?: Date;
  until?: Date;
  /** The recording's facts, exactly; a window on the call time. */
  campaign?: string;
  agent?: string;
  disposition?: string;
  source?: string;
  callSince?: Date;
  callUntil?: Date;
  page?: number;
  pageSize?: number;
}

export interface SearchHitRow {
  recording: RecordingRow;
  transcriptId: string;
  segmentIndex: number;
  startSeconds: number;
  endSeconds: number;
  textRoman: string;
  textScript: string;
  highlightRoman: string;
  highlightScript: string;
  language: string;
}

export interface SearchPageRows {
  hits: SearchHitRow[];
  page: number;
  pageSize: number;
  total: number;
  processingMs: number;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly clients: Clients,
    private readonly recordings: RecordingsService,
  ) {}

  async search(workspaceId: string, input: SearchQuery): Promise<SearchPageRows> {
    const query = input.query.trim();
    if (!query) throw invalid('Type a word or two to search for.');
    if (query.length > 200) throw invalid('The search is too long.');
    let reply;
    try {
      reply = await this.clients.search.search({
        workspaceId,
        query,
        language: input.language ?? '',
        recordingId: input.recordingId ?? '',
        since: input.since ? timestampFromDate(input.since) : undefined,
        until: input.until ? timestampFromDate(input.until) : undefined,
        campaign: input.campaign?.trim() ?? '',
        agent: input.agent?.trim() ?? '',
        disposition: input.disposition?.trim() ?? '',
        source: input.source?.trim() ?? '',
        callSince: input.callSince ? timestampFromDate(input.callSince) : undefined,
        callUntil: input.callUntil ? timestampFromDate(input.callUntil) : undefined,
        page: input.page ?? 0,
        pageSize: input.pageSize ?? 0,
      });
    } catch (error) {
      throw fromRpc(error, 'search');
    }
    const recordings = await this.recordings.byIds(
      workspaceId,
      reply.hits.map((hit) => hit.recordingId),
    );
    const hits: SearchHitRow[] = [];
    for (const hit of reply.hits) {
      const recording = recordings.get(hit.recordingId);
      if (!recording) continue; // deleted since it was indexed, or not this workspace's
      hits.push({
        recording,
        transcriptId: hit.transcriptId,
        segmentIndex: hit.segmentIndex,
        startSeconds: hit.startSeconds,
        endSeconds: hit.endSeconds,
        textRoman: hit.textRoman,
        textScript: hit.textScript,
        highlightRoman: hit.highlightRoman,
        highlightScript: hit.highlightScript,
        language: hit.language,
      });
    }
    return {
      hits,
      page: reply.page,
      pageSize: reply.pageSize,
      total: reply.total,
      processingMs: reply.processingMs,
    };
  }
}
