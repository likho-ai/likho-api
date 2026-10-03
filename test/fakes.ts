/**
 * The three services as likho-api sees them, answering real gRPC on local ports.
 * Tests change what they answer and read what they were asked.
 */
import { Code, ConnectError, ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Script } from '@likho-ai/contracts/common/v1/common_pb';
import { LanguageService } from '@likho-ai/contracts/language/v1/language_pb';
import { MediaKind, MediaService, MediaStatus } from '@likho-ai/contracts/media/v1/media_pb';
import {
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

export class FakeLanguage {
  terms = new Map<string, { id: string; term: string; language: string; enabled: boolean; note: string }>();
  spellings = new Map<
    string,
    { id: string; source: string; target: string; isPhrase: boolean; enabled: boolean }
  >();
  counter = 0;

  routes(router: ConnectRouter) {
    router.service(LanguageService, {
      listGlossaryTerms: () => ({ terms: [...this.terms.values()] }),
      upsertGlossaryTerm: (req) => {
        const term = { ...req.term!, id: req.term!.id || `glo_${this.counter++}` };
        this.terms.set(term.id, term);
        return { term };
      },
      deleteGlossaryTerm: (req) => {
        if (!this.terms.delete(req.id)) throw new ConnectError('not found', Code.NotFound);
        return {};
      },
      listSpellings: () => ({ spellings: [...this.spellings.values()] }),
      upsertSpelling: (req) => {
        const spelling = {
          ...req.spelling!,
          id: req.spelling!.id || `spl_${this.counter++}`,
          isPhrase: req.spelling!.source.includes(' '),
        };
        this.spellings.set(spelling.id, spelling);
        return { spelling };
      },
      deleteSpelling: (req) => {
        if (!this.spellings.delete(req.id)) throw new ConnectError('not found', Code.NotFound);
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
