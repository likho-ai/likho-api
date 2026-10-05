/**
 * The workspace's glossary (names the model listens for) and spelling table, kept by
 * likho-language, with how often each was heard. Used by GraphQL and by the REST CSV endpoints.
 */
import { Injectable } from '@nestjs/common';
import { timestampDate } from '@bufbuild/protobuf/wkt';
import type {
  GlossaryTerm as GlossaryTermPb,
  Spelling as SpellingPb,
  SpellingExample as SpellingExamplePb,
} from '@likho-ai/contracts/language/v1/language_pb';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/auth.service.js';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { invalid } from '../common/errors.js';
import { formatCsv, parseGlossaryCsv, parseSpellingsCsv } from './csv.js';

export interface GlossaryTerm {
  id: string;
  term: string;
  language: string;
  enabled: boolean;
  note: string;
  isPhrase: boolean;
  heard: number;
  lastHeardAt: Date | null;
}

export interface SpellingExample {
  recordingId: string;
  segmentIndex: number;
  before: string;
  after: string;
  heardAt: Date | null;
}

export interface Spelling {
  id: string;
  source: string;
  target: string;
  isPhrase: boolean;
  enabled: boolean;
  applied: number;
  lastAppliedAt: Date | null;
  examples: SpellingExample[];
}

export interface GlossaryTermInput {
  id?: string | null;
  term: string;
  language?: string | null;
  enabled?: boolean | null;
  note?: string | null;
}

export interface SpellingInput {
  id?: string | null;
  source: string;
  target: string;
  enabled?: boolean | null;
}

export interface ImportResult {
  added: number;
  updated: number;
}

const termFromPb = (t: GlossaryTermPb): GlossaryTerm => ({
  id: t.id,
  term: t.term,
  language: t.language,
  enabled: t.enabled,
  note: t.note,
  isPhrase: t.isPhrase,
  heard: Number(t.heard),
  lastHeardAt: t.lastHeardAt ? timestampDate(t.lastHeardAt) : null,
});

const exampleFromPb = (e: SpellingExamplePb): SpellingExample => ({
  recordingId: e.recordingId,
  segmentIndex: e.segmentIndex,
  before: e.before,
  after: e.after,
  heardAt: e.heardAt ? timestampDate(e.heardAt) : null,
});

const spellingFromPb = (s: SpellingPb): Spelling => ({
  id: s.id,
  source: s.source,
  target: s.target,
  isPhrase: s.isPhrase,
  enabled: s.enabled,
  applied: Number(s.applied),
  lastAppliedAt: s.lastAppliedAt ? timestampDate(s.lastAppliedAt) : null,
  examples: s.examples.map(exampleFromPb),
});

export const GLOSSARY_COLUMNS = ['term', 'language', 'enabled', 'note', 'heard', 'last_heard_at'];
export const SPELLING_COLUMNS = ['source', 'target', 'enabled', 'applied', 'last_applied_at'];

@Injectable()
export class VocabularyService {
  constructor(
    private readonly clients: Clients,
    private readonly audit: AuditService,
  ) {}

  private async language<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw fromRpc(error, 'language');
    }
  }

  // ---------------------------------------------------------------- glossary

  async glossary(me: Principal): Promise<GlossaryTerm[]> {
    const reply = await this.language(() =>
      this.clients.language.listGlossaryTerms({ workspaceId: me.workspaceId }),
    );
    return reply.terms.map(termFromPb);
  }

  async upsertGlossaryTerm(me: Principal, input: GlossaryTermInput): Promise<GlossaryTerm> {
    if (!input.term.trim()) throw invalid('A term is required.');
    const reply = await this.language(() =>
      this.clients.language.upsertGlossaryTerm({
        workspaceId: me.workspaceId,
        term: {
          id: input.id ?? '',
          term: input.term.trim(),
          language: input.language ?? 'hi',
          enabled: input.enabled ?? true,
          note: input.note ?? '',
        },
      }),
    );
    const term = termFromPb(reply.term!);
    await this.audit.record(
      me,
      input.id ? 'glossary.updated' : 'glossary.added',
      { kind: 'glossary_term', id: term.id },
      { term: term.term, enabled: term.enabled },
    );
    return term;
  }

  async deleteGlossaryTerm(me: Principal, id: string): Promise<void> {
    await this.language(() => this.clients.language.deleteGlossaryTerm({ workspaceId: me.workspaceId, id }));
    await this.audit.record(me, 'glossary.deleted', { kind: 'glossary_term', id });
  }

  /** Many terms from CSV (term, language, enabled, note); a term already there is updated. */
  async importGlossaryCsv(me: Principal, csv: string): Promise<ImportResult> {
    const rows = parseGlossaryCsv(csv);
    if (rows.length === 0) return { added: 0, updated: 0 };
    const reply = await this.language(() =>
      this.clients.language.importGlossaryTerms({ workspaceId: me.workspaceId, terms: rows }),
    );
    const result = { added: reply.added, updated: reply.updated };
    await this.audit.record(
      me,
      'glossary.imported',
      { kind: 'workspace', id: me.workspaceId },
      {
        ...result,
        rows: rows.length,
      },
    );
    return result;
  }

  async glossaryCsv(me: Principal): Promise<string> {
    const terms = await this.glossary(me);
    return formatCsv([
      GLOSSARY_COLUMNS,
      ...terms.map((t) => [t.term, t.language, t.enabled, t.note, t.heard, t.lastHeardAt]),
    ]);
  }

  // ---------------------------------------------------------------- spellings

  async spellings(me: Principal): Promise<Spelling[]> {
    const reply = await this.language(() =>
      this.clients.language.listSpellings({ workspaceId: me.workspaceId }),
    );
    return reply.spellings.map(spellingFromPb);
  }

  async upsertSpelling(me: Principal, input: SpellingInput): Promise<Spelling> {
    if (!input.source.trim() || !input.target.trim())
      throw invalid('Both the source and the target are required.');
    const reply = await this.language(() =>
      this.clients.language.upsertSpelling({
        workspaceId: me.workspaceId,
        spelling: {
          id: input.id ?? '',
          source: input.source.trim(),
          target: input.target.trim(),
          enabled: input.enabled ?? true,
        },
      }),
    );
    const spelling = spellingFromPb(reply.spelling!);
    await this.audit.record(
      me,
      input.id ? 'spelling.updated' : 'spelling.added',
      { kind: 'spelling', id: spelling.id },
      { source: spelling.source, target: spelling.target, enabled: spelling.enabled },
    );
    return spelling;
  }

  async deleteSpelling(me: Principal, id: string): Promise<void> {
    await this.language(() => this.clients.language.deleteSpelling({ workspaceId: me.workspaceId, id }));
    await this.audit.record(me, 'spelling.deleted', { kind: 'spelling', id });
  }

  /** Many spellings from CSV (source, target, enabled); a source already there is updated. */
  async importSpellingsCsv(me: Principal, csv: string): Promise<ImportResult> {
    const rows = parseSpellingsCsv(csv);
    if (rows.length === 0) return { added: 0, updated: 0 };
    const reply = await this.language(() =>
      this.clients.language.importSpellings({ workspaceId: me.workspaceId, spellings: rows }),
    );
    const result = { added: reply.added, updated: reply.updated };
    await this.audit.record(
      me,
      'spelling.imported',
      { kind: 'workspace', id: me.workspaceId },
      {
        ...result,
        rows: rows.length,
      },
    );
    return result;
  }

  async spellingsCsv(me: Principal): Promise<string> {
    const spellings = await this.spellings(me);
    return formatCsv([
      SPELLING_COLUMNS,
      ...spellings.map((s) => [s.source, s.target, s.enabled, s.applied, s.lastAppliedAt]),
    ]);
  }
}
