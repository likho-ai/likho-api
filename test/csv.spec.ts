import { describe, expect, it } from 'vitest';
import { formatCsv, parseCsv, parseGlossaryCsv, parseSpellingsCsv } from '../src/vocabulary/csv.js';

describe('CSV', () => {
  it('reads quotes, doubled quotes, commas and line breaks inside fields, CR LF and LF', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"two\nlines",\n\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['two\nlines', ''],
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('one')).toEqual([['one']]);
  });

  it('writes what it reads', () => {
    const rows = [
      ['term', 'note'],
      ['x, y', 'say "hi"'],
      ['plain', ''],
    ];
    const text = formatCsv(rows);
    expect(text).toBe('term,note\r\n"x, y","say ""hi"""\r\nplain,\r\n');
    expect(parseCsv(text)).toEqual(rows);
    expect(formatCsv([[true, 3, null, new Date('2026-10-05T07:00:00Z')]])).toBe(
      'true,3,,2026-10-05T07:00:00.000Z\r\n',
    );
  });

  it('reads the glossary by column name, in any order and case, with defaults', () => {
    expect(
      parseGlossaryCsv(
        'Note,Enabled,TERM,language\r\na herb,yes,अश्वगंधा,\r\n,no,"Triphala Churna",EN\r\n,,नीम,hi\r\n',
      ),
    ).toEqual([
      { term: 'अश्वगंधा', language: 'hi', enabled: true, note: 'a herb' },
      { term: 'Triphala Churna', language: 'en', enabled: false, note: '' },
      { term: 'नीम', language: 'hi', enabled: true, note: '' },
    ]);
    expect(parseGlossaryCsv('term\n')).toEqual([]);
  });

  it('reads spellings', () => {
    expect(parseSpellingsCsv('source,target,enabled\nनीम,Neem,\nकल तक,by tomorrow,false\n')).toEqual([
      { source: 'नीम', target: 'Neem', enabled: true },
      { source: 'कल तक', target: 'by tomorrow', enabled: false },
    ]);
  });

  it('says what is wrong', () => {
    expect(() => parseGlossaryCsv('')).toThrow('empty');
    expect(() => parseGlossaryCsv('language,note\nhi,x')).toThrow('"term" is missing');
    expect(() => parseGlossaryCsv('term,enabled\nx,maybe')).toThrow('Line 2: enabled must be true or false');
    expect(() => parseGlossaryCsv('term,note\n,x')).toThrow('Line 2: the term is empty');
    expect(() => parseSpellingsCsv('source,target\nनीम,')).toThrow('Line 2: both the source and the target');
    expect(() => parseSpellingsCsv('source\nनीम')).toThrow('"target" is missing');
  });
});
