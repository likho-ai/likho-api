/**
 * The other services as likho-api sees them, answering real gRPC on local ports.
 * Tests change what they answer and read what they were asked.
 */
import { Code, ConnectError, ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { timestampDate, timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Script } from '@likho-ai/contracts/common/v1/common_pb';
import {
  AnalyticsService,
  type Bucket,
  type Dimension,
  type Metric,
} from '@likho-ai/contracts/analytics/v1/analytics_pb';
import { DialerService } from '@likho-ai/contracts/dialer/v1/dialer_pb';
import { InsightsSchema, InsightsService } from '@likho-ai/contracts/insights/v1/insights_pb';
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

/** likho-insights: the insights a test put in, by transcript; remembers what it was asked to analyse. */
export class FakeInsights {
  docs = new Map<string, Record<string, any>>();
  asked: { transcriptId: string; workspaceId: string; force: boolean }[] = [];
  /** False: no model is configured there, as when ANTHROPIC_API_KEY is empty. */
  enabled = true;

  /** The insights of a transcript, as the model would have made them. */
  add(transcriptId: string, recordingId: string, workspaceId: string, extra: Record<string, unknown> = {}) {
    const doc: Record<string, any> = {
      id: newId('ins'),
      transcriptId,
      recordingId,
      workspaceId,
      transcriptVersion: 1,
      summary:
        'A customer asked about a product; the agent gave the price and the delivery; the order was placed.',
      intent: 'order a product',
      products: ['Ashwagandha'],
      sentiment: 'positive',
      checks: [
        { key: 'greeting', label: 'The agent greeted the customer', answer: 'yes', evidence: 'namaste' },
        { key: 'closing', label: 'The agent closed the call properly', answer: 'na', evidence: '' },
      ],
      scores: [
        { key: 'communication', label: 'Clarity and tone', score: 4, max: 5, reason: 'Clear and polite.' },
        {
          key: 'resolution',
          label: 'The need was handled',
          score: 9,
          max: 10,
          reason: 'The order was placed.',
        },
      ],
      scoreTotal: 13,
      scoreMax: 15,
      model: 'fake/one',
      inputTokens: 100,
      outputTokens: 50,
      formVersion: 'example-1',
      createdAt: timestampFromDate(new Date()),
      ...extra,
    };
    this.docs.set(transcriptId, doc);
    return doc;
  }

  routes(router: ConnectRouter) {
    router.service(InsightsService, {
      getInsights: (req) => {
        const doc = req.transcriptId
          ? this.docs.get(req.transcriptId)
          : [...this.docs.values()].filter((d) => d.recordingId === req.recordingId).at(-1);
        if (!doc) throw new ConnectError('no insights for it yet', Code.NotFound);
        return { insights: create(InsightsSchema, doc) };
      },
      analyse: (req) => {
        this.asked.push({ transcriptId: req.transcriptId, workspaceId: req.workspaceId, force: req.force });
        if (!this.enabled)
          throw new ConnectError(
            'No model is configured (ANTHROPIC_API_KEY is empty): nothing is analysed and no text leaves.',
            Code.FailedPrecondition,
          );
        const doc = this.docs.get(req.transcriptId);
        if (!doc) throw new ConnectError(`Transcript ${req.transcriptId} was not found`, Code.NotFound);
        if (req.force) doc.createdAt = timestampFromDate(new Date());
        return { insights: create(InsightsSchema, doc) };
      },
      getStatus: () => ({
        enabled: this.enabled,
        model: this.enabled ? 'fake/one' : '',
        formVersion: 'example-1',
      }),
    });
  }
}

/** likho-analytics: canned numbers, and a record of what it was asked. */
export class FakeAnalytics {
  asked: {
    method: 'overview' | 'timeseries' | 'breakdown';
    workspaceId: string;
    since?: Date;
    until?: Date;
    facts: Record<string, string>;
    metric?: Metric;
    bucket?: Bucket;
    by?: Dimension;
    limit?: number;
  }[] = [];

  routes(router: ConnectRouter) {
    const seen = (
      method: 'overview' | 'timeseries' | 'breakdown',
      req: {
        workspaceId: string;
        window?: { since?: { seconds: bigint; nanos: number }; until?: { seconds: bigint; nanos: number } };
        facts?: { campaign: string; agent: string; disposition: string; source: string; language: string };
      },
      extra: Partial<FakeAnalytics['asked'][number]> = {},
    ) => {
      const facts: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.facts ?? {}))
        if (value && !key.startsWith('$')) facts[key] = value;
      this.asked.push({
        method,
        workspaceId: req.workspaceId,
        since: req.window?.since ? timestampDate(req.window.since as never) : undefined,
        until: req.window?.until ? timestampDate(req.window.until as never) : undefined,
        facts,
        ...extra,
      });
    };
    router.service(AnalyticsService, {
      getOverview: (req) => {
        seen('overview', req);
        return {
          overview: {
            calls: 12n,
            transcribed: 10n,
            failed: 1n,
            minutes: 25.5,
            realtimeFactor: 0.9,
            analysed: 4n,
            score: 0.75,
            sentiments: [
              { key: 'positive', count: 3n },
              { key: 'negative', count: 1n },
            ],
            languages: [
              { key: 'hi', count: 8n },
              { key: 'ur', count: 2n },
            ],
          },
        };
      },
      getTimeseries: (req) => {
        seen('timeseries', req, { metric: req.metric, bucket: req.bucket });
        const since = req.window?.since ? timestampDate(req.window.since) : new Date(0);
        return {
          points: [
            { at: timestampFromDate(since), value: 5 },
            { at: timestampFromDate(new Date(since.getTime() + 86_400_000)), value: 7 },
          ],
        };
      },
      getBreakdown: (req) => {
        seen('breakdown', req, { by: req.by, limit: req.limit });
        return {
          rows: [
            { key: 'asha', calls: 7n, transcribed: 7n, minutes: 15, analysed: 3n, score: 0.8, negative: 1n },
            {
              key: 'ravi',
              calls: 5n,
              transcribed: 3n,
              minutes: 10.5,
              analysed: 1n,
              score: 0.6,
              negative: 0n,
            },
          ],
        };
      },
    });
  }
}

/** The dialer connector: what the dialer knows about its calls, from made-up calls, and its status. */
export class FakeDialer {
  calls: {
    crtObjectId: string;
    callId: string;
    callTime: string;
    campaign: string;
    agent: string;
    agentId: string;
    connected: boolean;
    talkSeconds: number;
  }[] = [];
  asked: {
    method: string;
    since?: Date;
    until?: Date;
    campaign?: string;
    agent?: string;
    after?: string;
    limit?: number;
  }[] = [];
  down = false;

  routes(router: ConnectRouter) {
    const guard = () => {
      if (this.down) throw new ConnectError('connector down', Code.Unavailable);
    };
    const inWindow = (w?: {
      since?: { seconds: bigint; nanos: number };
      until?: { seconds: bigint; nanos: number };
    }) => {
      const since = w?.since ? timestampDate(w.since as never) : new Date(0);
      const until = w?.until ? timestampDate(w.until as never) : new Date(8.64e15);
      return {
        since,
        until,
        calls: this.calls.filter((c) => new Date(c.callTime) >= since && new Date(c.callTime) < until),
      };
    };
    const group = (calls: FakeDialer['calls'], key: (c: FakeDialer['calls'][number]) => string) => {
      const by = new Map<string, FakeDialer['calls']>();
      for (const c of calls) by.set(key(c), [...(by.get(key(c)) ?? []), c]);
      return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
    };
    router.service(DialerService, {
      listCampaigns: (req) => {
        guard();
        const { since, until, calls } = inWindow(req.window);
        this.asked.push({ method: 'campaigns', since, until });
        return {
          campaigns: group(calls, (c) => c.campaign).map(([name, cs]) => ({
            name,
            calls: BigInt(cs.length),
            connected: BigInt(cs.filter((c) => c.connected).length),
            interactions: BigInt(new Set(cs.map((c) => c.crtObjectId)).size),
            talkSeconds: BigInt(cs.reduce((a, c) => a + c.talkSeconds, 0)),
          })),
        };
      },
      listAgents: (req) => {
        guard();
        const { since, until, calls } = inWindow(req.window);
        this.asked.push({ method: 'agents', since, until, campaign: req.campaign });
        const mine = calls.filter((c) => !req.campaign || c.campaign === req.campaign);
        return {
          agents: group(mine, (c) => c.agent).map(([name, cs]) => ({
            id: cs[0]!.agentId,
            name,
            calls: BigInt(cs.length),
            connected: BigInt(cs.filter((c) => c.connected).length),
            talkSeconds: BigInt(cs.reduce((a, c) => a + c.talkSeconds, 0)),
          })),
        };
      },
      listCalls: (req) => {
        guard();
        const { since, until, calls } = inWindow(req.window);
        this.asked.push({
          method: 'calls',
          since,
          until,
          campaign: req.campaign,
          agent: req.agent,
          after: req.after,
          limit: req.limit,
        });
        const all = calls
          .filter(
            (c) => (!req.campaign || c.campaign === req.campaign) && (!req.agent || c.agent === req.agent),
          )
          .filter((c) => (!req.connectedOnly || c.connected) && c.talkSeconds >= req.minTalkSeconds)
          .sort((a, b) => b.callTime.localeCompare(a.callTime));
        const start = req.after ? Number(req.after) : 0;
        const page = all.slice(start, start + (req.limit || 50));
        return {
          calls: page.map((c) => ({
            ...c,
            callType: 'inbound.call.dial',
            disposition: 'Sale',
            phone: '…1234',
            hangupBy: 'customer',
            queue: '',
            transferredCampaign: '',
          })),
          nextCursor: start + page.length < all.length ? String(start + page.length) : '',
        };
      },
      getCall: (req) => {
        guard();
        const c = this.calls.find((x) => x.crtObjectId === req.crtObjectId);
        if (!c) throw new ConnectError('no such call', Code.NotFound);
        return {
          call: {
            ...c,
            callType: 'inbound.call.dial',
            disposition: 'Sale',
            phone: '…1234',
            hangupBy: 'customer',
            queue: '',
            transferredCampaign: '',
          },
        };
      },
      getStatus: () => {
        guard();
        return {
          databaseConfigured: true,
          scheduleEnabled: false,
          cursor: '2026-10-02 10:00:00',
          importedToday: 3,
          dailyLimit: 200,
          campaigns: [],
          minTalkSeconds: 20,
          writebackEnabled: false,
          archiveEnabled: true,
          version: '0.4.0',
          lastRunSummary: '',
        };
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
