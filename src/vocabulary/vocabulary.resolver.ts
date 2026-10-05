/** The workspace's glossary and spelling table (kept by likho-language), with how often each was heard. */
import { Args, Field, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { VocabularyService } from './vocabulary.service.js';

@ObjectType()
export class GlossaryTerm {
  @Field() id: string;
  @Field({ description: 'A name, or a whole phrase, in the script of the audio.' }) term: string;
  @Field() language: string;
  @Field() enabled: boolean;
  @Field() note: string;
  @Field({ description: 'Several words: matched as a whole, and a multi-word hotword.' }) isPhrase: boolean;
  @Field(() => Int, { description: 'How many transcript lines contained the term.' }) heard: number;
  @Field(() => Date, { nullable: true }) lastHeardAt: Date | null;
}

@ObjectType()
export class SpellingExample {
  @Field() recordingId: string;
  @Field(() => Int) segmentIndex: number;
  @Field({ description: 'The line as the model wrote it.' }) before: string;
  @Field({ description: 'The line as it was written in Hinglish.' }) after: string;
  @Field(() => Date, { nullable: true }) heardAt: Date | null;
}

@ObjectType()
export class Spelling {
  @Field() id: string;
  @Field({ description: 'What the model writes, in the source script.' }) source: string;
  @Field({ description: 'How it must appear in Hinglish.' }) target: string;
  @Field() isPhrase: boolean;
  @Field() enabled: boolean;
  @Field(() => Int, { description: 'How many transcript lines the spelling was applied to.' })
  applied: number;
  @Field(() => Date, { nullable: true }) lastAppliedAt: Date | null;
  @Field(() => [SpellingExample], { description: 'The last few lines it was applied to, newest first.' })
  examples: SpellingExample[];
}

@ObjectType()
export class ImportResult {
  @Field(() => Int) added: number;
  @Field(() => Int) updated: number;
}

@InputType()
export class GlossaryTermInput {
  @Field({ nullable: true, description: 'Empty: a new term, or the one with the same text.' }) id?: string;
  @Field() term: string;
  @Field({ nullable: true }) language?: string;
  @Field({ nullable: true }) enabled?: boolean;
  @Field({ nullable: true }) note?: string;
}

@InputType()
export class SpellingInput {
  @Field({ nullable: true }) id?: string;
  @Field() source: string;
  @Field() target: string;
  @Field({ nullable: true }) enabled?: boolean;
}

@Resolver()
export class VocabularyResolver {
  constructor(private readonly vocabulary: VocabularyService) {}

  @Query(() => [GlossaryTerm])
  glossary(@CurrentUser() me: Principal): Promise<GlossaryTerm[]> {
    return this.vocabulary.glossary(me);
  }

  @Query(() => String, {
    description: 'The glossary as CSV: term, language, enabled, note, heard, last_heard_at.',
  })
  glossaryCsv(@CurrentUser() me: Principal): Promise<string> {
    return this.vocabulary.glossaryCsv(me);
  }

  @MinRole('member')
  @Mutation(() => GlossaryTerm)
  upsertGlossaryTerm(
    @CurrentUser() me: Principal,
    @Args('input') input: GlossaryTermInput,
  ): Promise<GlossaryTerm> {
    return this.vocabulary.upsertGlossaryTerm(me, input);
  }

  @MinRole('member')
  @Mutation(() => Boolean)
  async deleteGlossaryTerm(@CurrentUser() me: Principal, @Args('id') id: string): Promise<boolean> {
    await this.vocabulary.deleteGlossaryTerm(me, id);
    return true;
  }

  @MinRole('member')
  @Mutation(() => ImportResult, {
    description:
      'Many terms from CSV. The first line names the columns: term (required), language, enabled, note. A term already there is updated.',
  })
  importGlossaryCsv(@CurrentUser() me: Principal, @Args('csv') csv: string): Promise<ImportResult> {
    return this.vocabulary.importGlossaryCsv(me, csv);
  }

  @Query(() => [Spelling])
  spellings(@CurrentUser() me: Principal): Promise<Spelling[]> {
    return this.vocabulary.spellings(me);
  }

  @Query(() => String, {
    description: 'The spellings as CSV: source, target, enabled, applied, last_applied_at.',
  })
  spellingsCsv(@CurrentUser() me: Principal): Promise<string> {
    return this.vocabulary.spellingsCsv(me);
  }

  @MinRole('member')
  @Mutation(() => Spelling)
  upsertSpelling(@CurrentUser() me: Principal, @Args('input') input: SpellingInput): Promise<Spelling> {
    return this.vocabulary.upsertSpelling(me, input);
  }

  @MinRole('member')
  @Mutation(() => Boolean)
  async deleteSpelling(@CurrentUser() me: Principal, @Args('id') id: string): Promise<boolean> {
    await this.vocabulary.deleteSpelling(me, id);
    return true;
  }

  @MinRole('member')
  @Mutation(() => ImportResult, {
    description:
      'Many spellings from CSV. The first line names the columns: source and target (required), enabled. A source already there is updated.',
  })
  importSpellingsCsv(@CurrentUser() me: Principal, @Args('csv') csv: string): Promise<ImportResult> {
    return this.vocabulary.importSpellingsCsv(me, csv);
  }
}
