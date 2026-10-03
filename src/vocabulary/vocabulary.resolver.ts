/** The workspace's glossary (names the model listens for) and spelling table, kept by likho-language. */
import { Args, Field, InputType, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { Clients, fromRpc } from '../clients/clients.module.js';
import { invalid } from '../common/errors.js';

@ObjectType()
export class GlossaryTerm {
  @Field() id: string;
  @Field() term: string;
  @Field() language: string;
  @Field() enabled: boolean;
  @Field() note: string;
}

@ObjectType()
export class Spelling {
  @Field() id: string;
  @Field({ description: 'What the model writes, in the source script.' }) source: string;
  @Field({ description: 'How it must appear in Hinglish.' }) target: string;
  @Field() isPhrase: boolean;
  @Field() enabled: boolean;
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
  constructor(private readonly clients: Clients) {}

  @Query(() => [GlossaryTerm])
  async glossary(@CurrentUser() me: Principal): Promise<GlossaryTerm[]> {
    try {
      const reply = await this.clients.language.listGlossaryTerms({ workspaceId: me.workspaceId });
      return reply.terms;
    } catch (error) {
      throw fromRpc(error, 'language');
    }
  }

  @Mutation(() => GlossaryTerm)
  async upsertGlossaryTerm(
    @CurrentUser() me: Principal,
    @Args('input') input: GlossaryTermInput,
  ): Promise<GlossaryTerm> {
    if (!input.term.trim()) throw invalid('A term is required.');
    try {
      const reply = await this.clients.language.upsertGlossaryTerm({
        workspaceId: me.workspaceId,
        term: {
          id: input.id ?? '',
          term: input.term.trim(),
          language: input.language ?? 'hi',
          enabled: input.enabled ?? true,
          note: input.note ?? '',
        },
      });
      return reply.term!;
    } catch (error) {
      throw fromRpc(error, 'language');
    }
  }

  @Mutation(() => Boolean)
  async deleteGlossaryTerm(@CurrentUser() me: Principal, @Args('id') id: string): Promise<boolean> {
    try {
      await this.clients.language.deleteGlossaryTerm({ workspaceId: me.workspaceId, id });
      return true;
    } catch (error) {
      throw fromRpc(error, 'language');
    }
  }

  @Query(() => [Spelling])
  async spellings(@CurrentUser() me: Principal): Promise<Spelling[]> {
    try {
      const reply = await this.clients.language.listSpellings({ workspaceId: me.workspaceId });
      return reply.spellings;
    } catch (error) {
      throw fromRpc(error, 'language');
    }
  }

  @Mutation(() => Spelling)
  async upsertSpelling(@CurrentUser() me: Principal, @Args('input') input: SpellingInput): Promise<Spelling> {
    if (!input.source.trim() || !input.target.trim())
      throw invalid('Both the source and the target are required.');
    try {
      const reply = await this.clients.language.upsertSpelling({
        workspaceId: me.workspaceId,
        spelling: {
          id: input.id ?? '',
          source: input.source.trim(),
          target: input.target.trim(),
          isPhrase: false,
          enabled: input.enabled ?? true,
        },
      });
      return reply.spelling!;
    } catch (error) {
      throw fromRpc(error, 'language');
    }
  }

  @Mutation(() => Boolean)
  async deleteSpelling(@CurrentUser() me: Principal, @Args('id') id: string): Promise<boolean> {
    try {
      await this.clients.language.deleteSpelling({ workspaceId: me.workspaceId, id });
      return true;
    } catch (error) {
      throw fromRpc(error, 'language');
    }
  }
}
