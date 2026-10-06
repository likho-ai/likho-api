import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'node:path';
import type { GraphQLFormattedError } from 'graphql';
import { AnalyticsController } from './analytics/analytics.controller.js';
import { AnalyticsResolver } from './analytics/analytics.resolver.js';
import { AnalyticsService } from './analytics/analytics.service.js';
import { AuditResolver } from './audit/audit.resolver.js';
import { DialerController } from './dialer/dialer.controller.js';
import { DialerResolver } from './dialer/dialer.resolver.js';
import { DialerService } from './dialer/dialer.service.js';
import { SettingsController } from './settings/settings.controller.js';
import { SettingsService } from './settings/settings.service.js';
import { SystemResolver } from './system/system.resolver.js';
import { SystemService } from './system/system.service.js';
import { AuthModule } from './auth/auth.module.js';
import { TokensController } from './auth/tokens.controller.js';
import { BusModule } from './bus/bus.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { LikhoError } from './common/errors.js';
import { Config, loadConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { ImportsResolver } from './imports/imports.resolver.js';
import { ImportsService } from './imports/imports.service.js';
import { InsightsController } from './insights/insights.controller.js';
import { InsightsResolver } from './insights/insights.resolver.js';
import { InsightsService } from './insights/insights.service.js';
import { LiveController } from './live/live.controller.js';
import { LiveModule } from './live/live.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { EventsConsumer } from './recordings/events.consumer.js';
import { JobsSweeper } from './recordings/jobs.sweeper.js';
import { JobsResolver, RecordingsResolver } from './recordings/recordings.resolver.js';
import { RecordingsService } from './recordings/recordings.service.js';
import {
  ImportsController,
  JobsController,
  RecordingsController,
  SearchController,
} from './rest/rest.controller.js';
import { SavedSearchesService } from './search/saved.service.js';
import { SearchResolver } from './search/search.resolver.js';
import { SearchService } from './search/search.service.js';
import { SettingsResolver } from './settings/settings.resolver.js';
import { TranscriptsResolver } from './transcripts/transcripts.resolver.js';
import { UsersResolver } from './users/users.resolver.js';
import { VocabularyController } from './vocabulary/vocabulary.controller.js';
import { VocabularyResolver } from './vocabulary/vocabulary.resolver.js';
import { VocabularyService } from './vocabulary/vocabulary.service.js';

/** GraphQL errors carry the same code as REST errors, in extensions.code. */
export function formatGraphQLError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  // Apollo hands over a GraphQLError wrapping what the resolver threw; look through it.
  const original = (error as { originalError?: unknown } | undefined)?.originalError ?? error;
  if (original instanceof LikhoError) {
    return { message: original.message, path: formatted.path, extensions: { code: original.code } };
  }
  if (
    formatted.extensions?.code === 'BAD_USER_INPUT' ||
    formatted.extensions?.code === 'GRAPHQL_VALIDATION_FAILED'
  ) {
    return { message: formatted.message, path: formatted.path, extensions: { code: 'invalid' } };
  }
  return formatted;
}

export function appModule(config?: Config) {
  @Module({
    imports: [
      ConfigModule.forRoot(config),
      MetricsModule,
      DbModule,
      BusModule,
      LiveModule,
      ClientsModule,
      AuthModule,
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        path: '/graphql',
        // Written on every development and test start, so the committed file is always current.
        // Staging and production run from a read-only image: the schema stays in memory there.
        autoSchemaFile: ['development', 'test'].includes((config ?? loadConfig()).LIKHO_ENV)
          ? join(process.cwd(), 'schema.graphql')
          : true,
        sortSchema: true,
        context: ({ req, res }: { req: unknown; res: unknown }) => ({ req, res }),
        formatError: formatGraphQLError,
        introspection: true,
        playground: false,
        includeStacktraceInErrorResponses: false,
      }),
    ],
    controllers: [
      HealthController,
      RecordingsController,
      JobsController,
      SearchController,
      ImportsController,
      VocabularyController,
      InsightsController,
      AnalyticsController,
      DialerController,
      SettingsController,
      TokensController,
      LiveController,
    ],
    providers: [
      RecordingsService,
      ImportsService,
      SearchService,
      SavedSearchesService,
      VocabularyService,
      InsightsService,
      AnalyticsService,
      DialerService,
      SettingsService,
      SystemService,
      EventsConsumer,
      JobsSweeper,
      RecordingsResolver,
      JobsResolver,
      SearchResolver,
      ImportsResolver,
      TranscriptsResolver,
      VocabularyResolver,
      InsightsResolver,
      AnalyticsResolver,
      DialerResolver,
      SystemResolver,
      SettingsResolver,
      UsersResolver,
      AuditResolver,
    ],
  })
  class AppModule {}
  return AppModule;
}
