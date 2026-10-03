import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.service.js';
import { SearchFilter, SearchPage } from './search.graphql.js';
import { SearchService } from './search.service.js';

@Resolver()
export class SearchResolver {
  constructor(private readonly service: SearchService) {}

  @Query(() => SearchPage, {
    description: 'Transcript lines matching a few words, in either layer, typos allowed; best first.',
  })
  async search(
    @CurrentUser() me: Principal,
    @Args('query') query: string,
    @Args('filter', { nullable: true }) filter?: SearchFilter,
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('pageSize', { type: () => Int, nullable: true }) pageSize?: number,
  ): Promise<SearchPage> {
    return this.service.search(me.workspaceId, {
      query,
      language: filter?.language,
      recordingId: filter?.recordingId,
      since: filter?.since,
      until: filter?.until,
      page,
      pageSize,
    });
  }
}
