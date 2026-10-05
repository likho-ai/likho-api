import { Args, Field, InputType, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser, MinRole } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { SavedSearch, SearchFilter, SearchPage } from './search.graphql.js';
import { filterOf, SavedSearchesService, type SavedSearchRow } from './saved.service.js';
import { SearchService } from './search.service.js';

@InputType()
export class SaveSearchInput {
  @Field({ description: 'A short name, e.g. "refunds, sales, last week".' }) name: string;
  @Field({ description: 'The words to search for.' }) query: string;
  @Field(() => SearchFilter, { nullable: true }) filter?: SearchFilter;
}

const savedSearch = (row: SavedSearchRow): SavedSearch => ({
  id: row.id,
  name: row.name,
  query: row.query,
  filter: filterOf(row),
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});

@Resolver()
export class SearchResolver {
  constructor(
    private readonly service: SearchService,
    private readonly saved: SavedSearchesService,
    private readonly audit: AuditService,
  ) {}

  @Query(() => SearchPage, {
    description:
      'Transcript lines matching a few words, in either layer, typos allowed; best first. Narrowed by language, recording, campaign, agent, disposition, source, or when the call happened.',
  })
  async search(
    @CurrentUser() me: Principal,
    @Args('query') query: string,
    @Args('filter', { nullable: true }) filter?: SearchFilter,
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('pageSize', { type: () => Int, nullable: true }) pageSize?: number,
  ): Promise<SearchPage> {
    return this.service.search(me.workspaceId, { query, ...filter, page, pageSize });
  }

  @Query(() => [SavedSearch], {
    description: 'The searches kept for later, newest first; shared by the workspace.',
  })
  async savedSearches(@CurrentUser() me: Principal): Promise<SavedSearch[]> {
    return (await this.saved.list(me.workspaceId)).map(savedSearch);
  }

  @MinRole('member')
  @Mutation(() => SavedSearch, { description: 'Keeps a search (the words and the filter) for later.' })
  async saveSearch(
    @CurrentUser() me: Principal,
    @Args('input') input: SaveSearchInput,
  ): Promise<SavedSearch> {
    const row = await this.saved.save(me, input);
    await this.audit.record(
      me,
      'search.saved',
      { kind: 'saved_search', id: row.id },
      { name: row.name, query: row.query },
    );
    return savedSearch(row);
  }

  @MinRole('member')
  @Mutation(() => Boolean, { description: 'Removes a saved search: who saved it, or an admin.' })
  async deleteSavedSearch(@CurrentUser() me: Principal, @Args('id') id: string): Promise<boolean> {
    const row = await this.saved.remove(me, id);
    await this.audit.record(me, 'search.deleted', { kind: 'saved_search', id }, { name: row.name });
    return true;
  }
}
