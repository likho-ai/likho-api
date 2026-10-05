/**
 * The three services as likho-api sees them, answering real gRPC on local ports.
 * Tests change what they answer and read what they were asked.
 */
import { Code, ConnectError, ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Script } from '@likho-ai/contracts/common/v1/common_pb';
import { LanguageService } from '@likho-ai/contracts/language/v1/language_pb';
import { MediaKind, MediaService, MediaStatus } from '@likho-ai/contracts/media/v1/media_pb';
import { HitSchema, SearchService, type Hit } from '@likho-ai/contracts/search/v1/search_pb';
import {
  Layer,
  TranscriptSchema,
  TranscriptionService,
  type Transcript,
} from '@likho-ai/contracts/transcription/v1/transcription_pb';
import { createServer, Http2Server } from 'node:http2';
import { AddressInfo } from 'node:net';
import { newId } from '../src/common/ids.js';

export class FakeMedia {
  uploads: {
    mediaId: string;
    recordingId: string;
    workspaceId: string;
    originalName: string;
    sha256: string;
  }[] = [];
  deleted: string[] = [];
  /** sha256 → media id that already holds that content. */
  known = new Map<string, string>();
  counter = 0;

  routes(router: ConnectRouter) {
    router.service(MediaService, {
      createUpload: (req) => {
        const existingId = req.sha256 ? this.known.get(req.sha256) : undefined;
        if (existingId) {
          return {
            mediaId: existingId,
            uploadUrl: '',
            existingMedia: { id: existingId, status: MediaStatus.READY, workspaceId: req.workspaceId },
          };
        }
        const mediaId = newId('med');
        this.uploads.push({
          mediaId,
          recordingId: req.recordingId,
          workspaceId: req.workspaceId,
          originalName: req.originalName,
          sha256: req.sha256,
        });
        return {
          mediaId,
          uploadUrl: `http://media.test/media/uploads/${mediaId}?token=t`,
          expiresAt: timestampFromDate(new Date(Date.now() + 3600_000)),
        };
      },
      getMedia: (req) => ({ media: { id: req.id, status: MediaStatus.READY } }),
      getDownloadUrl: (req) => ({
        url: `http://media.test/media/${req.id}/${req.kind === MediaKind.PEAKS ? 'peaks' : 'audio'}?sig=s`,
      }),
      deleteMedia: (req) => {
        this.deleted.push(req.id);
        return {};
      },
    });
  }
}

export class FakeTranscription {
  transcripts = new Map<string, Transcript>();
  cancelled: string[] = [];
  retransliterated: string[] = [];
  corrections: {
    id: string;
    recordingId: string;
    transcriptId: string;
    correctedTranscriptId: string;
    segmentIndex: number;
    layer: Layer;
    before: string;
    after: string;
    userId: string;
  }[] = [];

  /** Makes a transcript the service will answer with, as if a job stored it. */
  add(id: string, recordingId: string, jobId: string, version = 1): Transcript {
    const transcript = create(TranscriptSchema, {
      id,
      recordingId,
      jobId,
      version,
      model: { registryId: 'faster-whisper/turbo', engine: 'faster-whisper', compute: 'int8' },
      language: {
        detected: 'hi',
        probability: 0.9,
        candidates: [{ language: 'hi', probability: 0.9 }],
        decodedAs: 'hi',
        policy: 'auto',
      },
      script: Script.DEVANAGARI,
      segments: [
        { index: 0, startSeconds: 0.5, endSeconds: 2.1, textScript: 'नमस्ते', textRoman: 'namaste' },
        { index: 1, startSeconds: 2.4, endSeconds: 4.0, textScript: 'धन्यवाद', textRoman: 'dhanyavaad' },
      ],
      stats: { audioSeconds: 4, elapsedSeconds: 3, realtimeFactor: 1.3, chunks: 1, silenceSkippedSeconds: 0 },
      createdAt: timestampFromDate(new Date()),
    });
    this.transcripts.set(id, transcript);
    return transcript;
  }

  routes(router: ConnectRouter) {
    router.service(TranscriptionService, {
      getTranscript: (req) => {
        const transcript = this.transcripts.get(req.id);
        if (!transcript) throw new ConnectError(`transcript ${req.id} not found`, Code.NotFound);
        return { transcript };
      },
      listTranscripts: (req) => ({
        transcripts: [...this.transcripts.values()]
          .filter((t) => t.recordingId === req.recordingId)
          .sort((a, b) => b.version - a.version),
      }),
      retransliterate: (req) => {
        const old = this.transcripts.get(req.transcriptId);
        if (!old) throw new ConnectError('not found', Code.NotFound);
        this.retransliterated.push(req.transcriptId);
        return { transcript: this.add(`${old.id}v${old.version + 1}`, old.recordingId, '', old.version + 1) };
      },
      correctSegment: (req) => {
        const old = this.transcripts.get(req.transcriptId);
        if (!old) throw new ConnectError('not found', Code.NotFound);
        const line = old.segments[req.segmentIndex];
        if (!line) throw new ConnectError(`no line ${req.segmentIndex}`, Code.NotFound);
        const field = req.layer === Layer.SCRIPT ? 'textScript' : 'textRoman';
        const next = this.add(`${old.id}v${old.version + 1}`, old.recordingId, '', old.version + 1);
        next.segments[req.segmentIndex]![field] = req.text;
        if (req.layer === Layer.SCRIPT) next.segments[req.segmentIndex]!.textRoman = `roman(${req.text})`;
        const correction = {
          id: `cor_${this.corrections.length + 1}`,
          recordingId: old.recordingId,
          transcriptId: old.id,
          correctedTranscriptId: next.id,
          segmentIndex: req.segmentIndex,
          layer: req.layer,
          before: line[field],
          after: req.text,
          userId: req.userId,
        };
        this.corrections.unshift(correction);
        return { transcript: next, correction: { ...correction, createdAt: timestampFromDate(new Date()) } };
      },
      listCorrections: (req) => ({
        corrections: this.corrections
          .filter((c) => c.recordingId === req.recordingId)
          .map((c) => ({ ...c, createdAt: timestampFromDate(new Date()) })),
      }),
      listEngines: () => ({
        engines: [
          {
            registryId: 'faster-whisper/turbo',
            engine: 'faster-whisper',
            outputScript: Script.DEVANAGARI,
            available: true,
            isDefault: true,
          },
          {
            registryId: 'faster-whisper/base',
            engine: 'faster-whisper',
            outputScript: Script.DEVANAGARI,
            available: true,
            isDefault: false,
          },
        ],
      }),
      cancelJob: (req) => {
        this.cancelled.push(req.jobId);
        return { cancelled: true };
      },
    });
  }
}

export interface FakeTerm {
  id: string;
  term: string;
  language: string;
  enabled: boolean;
  note: string;
  heard: bigint;
  lastHeardAt?: { seconds: bigint; nanos: number };
}

export interface FakeSpelling {
  id: string;
  source: string;
  target: string;
  enabled: boolean;
  applied: bigint;
  lastAppliedAt?: { seconds: bigint; nanos: number };
  examples: {
    recordingId: string;
    segmentIndex: number;
    before: string;
    after: string;
    heardAt: { seconds: bigint; nanos: number };
  }[];
}

/** likho-language: keeps the glossary and spellings in memory; a test sets the counts it wants. */
export class FakeLanguage {
  terms = new Map<string, FakeTerm>();
  spellings = new Map<string, FakeSpelling>();
  counter = 0;
  version = 0;

  private term(id: string, t: { term: string; language: string; enabled: boolean; note: string }) {
    const existing = this.terms.get(id);
    const term: FakeTerm = { ...(existing ?? { heard: 0n }), ...t, id };
    this.terms.set(id, term);
    return { ...term, isPhrase: term.term.includes(' ') };
  }

  private spelling(id: string, s: { source: string; target: string; enabled: boolean }) {
    const existing = this.spellings.get(id);
    const spelling: FakeSpelling = { ...(existing ?? { applied: 0n, examples: [] }), ...s, id };
    this.spellings.set(id, spelling);
    return { ...spelling, isPhrase: spelling.source.includes(' ') };
  }

  routes(router: ConnectRouter) {
    router.service(LanguageService, {
      listGlossaryTerms: () => ({
        terms: [...this.terms.values()].map((t) => ({ ...t, isPhrase: t.term.includes(' ') })),
      }),
      upsertGlossaryTerm: (req) => {
        const t = req.term!;
        const id =
          t.id || [...this.terms.values()].find((x) => x.term === t.term)?.id || `glo_${this.counter++}`;
        return {
          term: this.term(id, { term: t.term, language: t.language, enabled: t.enabled, note: t.note }),
        };
      },
      deleteGlossaryTerm: (req) => {
        if (!this.terms.delete(req.id)) throw new ConnectError('not found', Code.NotFound);
        return {};
      },
      importGlossaryTerms: (req) => {
        let added = 0;
        let updated = 0;
        for (const t of req.terms) {
          const existing = [...this.terms.values()].find((x) => x.term === t.term);
          if (existing) updated++;
          else added++;
          this.term(existing?.id ?? `glo_${this.counter++}`, {
            term: t.term,
            language: t.language,
            enabled: t.enabled,
            note: t.note,
          });
        }
        return { added, updated, vocabularyVersion: BigInt(++this.version) };
      },
      listSpellings: () => ({
        spellings: [...this.spellings.values()].map((s) => ({ ...s, isPhrase: s.source.includes(' ') })),
      }),
      upsertSpelling: (req) => {
        const s = req.spelling!;
        const id =
          s.id ||
          [...this.spellings.values()].find((x) => x.source === s.source)?.id ||
          `spl_${this.counter++}`;
        return { spelling: this.spelling(id, { source: s.source, target: s.target, enabled: s.enabled }) };
      },
      deleteSpelling: (req) => {
        if (!this.spellings.delete(req.id)) throw new ConnectError('not found', Code.NotFound);
        return {};
      },
      importSpellings: (req) => {
        let added = 0;
        let updated = 0;
        for (const s of req.spellings) {
          const existing = [...this.spellings.values()].find((x) => x.source === s.source);
          if (existing) updated++;
          else added++;
          this.spelling(existing?.id ?? `spl_${this.counter++}`, {
            source: s.source,
            target: s.target,
            enabled: s.enabled,
          });
        }
        return { added, updated, vocabularyVersion: BigInt(++this.version) };
      },
    });
  }
}

/** likho-search: answers every search with the hits a test put in, and remembers what it was asked. */
export class FakeSearch {
  hits: Omit<Partial<Hit>, '$typeName'>[] = [];
  asked: {
    workspaceId: string;
    query: string;
    language: string;
    recordingId: string;
    page: number;
    pageSize: number;
    campaign: string;
    agent: string;
    disposition: string;
    source: string;
    callSince?: Date;
    callUntil?: Date;
  }[] = [];
  reindexed: string[] = [];
  deleted: string[] = [];

  routes(router: ConnectRouter) {
    router.service(SearchService, {
      search: (req) => {
        this.asked.push({
          workspaceId: req.workspaceId,
          query: req.query,
          language: req.language,
          recordingId: req.recordingId,
          page: req.page,
          pageSize: req.pageSize,
          campaign: req.campaign,
          agent: req.agent,
          disposition: req.disposition,
          source: req.source,
          callSince: req.callSince ? timestampDate(req.callSince) : undefined,
          callUntil: req.callUntil ? timestampDate(req.callUntil) : undefined,
        });
        return {
          hits: this.hits.map((hit) => create(HitSchema, hit)),
          page: req.page || 1,
          pageSize: req.pageSize || 20,
          total: this.hits.length,
          processingMs: 2,
        };
      },
      reindex: (req) => {
        this.reindexed.push(req.transcriptId);
        return { lines: 2 };
      },
      deleteRecording: (req) => {
        this.deleted.push(req.recordingId);
        return {};
      },
    });
  }
}

export interface FakeServer {
  address: string;
  close(): Promise<void>;
}

export async function serve(routes: (router: ConnectRouter) => void): Promise<FakeServer> {
  const server: Http2Server = createServer(connectNodeAdapter({ routes }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
