/** The vocabulary as CSV over REST, for scripts: download it, load it. */
import { Body, Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { invalid } from '../common/errors.js';
import { VocabularyService } from './vocabulary.service.js';

/** The CSV, sent as the request body (text/csv or text/plain) or as {"csv": "..."}. */
function csvOf(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && typeof (body as { csv?: unknown }).csv === 'string')
    return (body as { csv: string }).csv;
  throw invalid('Send the CSV as the request body with Content-Type: text/csv.');
}

const CSV_BODY = { description: 'The CSV; the first line names the columns.', schema: { type: 'string' } };

@ApiTags('vocabulary')
@ApiBearerAuth()
@Controller('api/v1/vocabulary')
export class VocabularyController {
  constructor(private readonly vocabulary: VocabularyService) {}

  @Get('glossary.csv')
  @ApiOperation({ summary: 'The glossary as CSV: term, language, enabled, note, heard, last_heard_at' })
  @ApiProduces('text/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  glossary(@CurrentUser() me: Principal): Promise<string> {
    return this.vocabulary.glossaryCsv(me);
  }

  @Post('glossary.csv')
  @MinRole('member')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Load terms from CSV',
    description: 'Columns: term (required), language, enabled, note. A term already there is updated.',
  })
  @ApiConsumes('text/csv')
  @ApiBody(CSV_BODY)
  importGlossary(@CurrentUser() me: Principal, @Body() body: unknown) {
    return this.vocabulary.importGlossaryCsv(me, csvOf(body));
  }

  @Get('spellings.csv')
  @ApiOperation({ summary: 'The spellings as CSV: source, target, enabled, applied, last_applied_at' })
  @ApiProduces('text/csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  spellings(@CurrentUser() me: Principal): Promise<string> {
    return this.vocabulary.spellingsCsv(me);
  }

  @Post('spellings.csv')
  @MinRole('member')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Load spellings from CSV',
    description: 'Columns: source and target (required), enabled. A source already there is updated.',
  })
  @ApiConsumes('text/csv')
  @ApiBody(CSV_BODY)
  importSpellings(@CurrentUser() me: Principal, @Body() body: unknown) {
    return this.vocabulary.importSpellingsCsv(me, csvOf(body));
  }
}
