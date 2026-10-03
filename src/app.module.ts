import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'node:path';
import type { GraphQLFormattedError } from 'graphql';
import { AuthModule } from './auth/auth.module.js';
import { BusModule } from './bus/bus.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { LikhoError } from './common/errors.js';
import { Config, loadConfig } from './config/config.js';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './db/db.module.js';
import { HealthController } from './health/health.controller.js';
import { LiveController } from './live/live.controller.js';
import { LiveModule } from './live/live.module.js';
import { EventsConsumer } from './recordings/events.consumer.js';
import { JobsResolver, RecordingsResolver } from './recordings/recordings.resolver.js';
import { RecordingsService } from './recordings/recordings.service.js';
import { JobsController, RecordingsController } from './rest/rest.controller.js';
import { SettingsResolver } from './settings/settings.resolver.js';
import { TranscriptsResolver } from './transcripts/transcripts.resolver.js';
import { VocabularyResolver } from './vocabulary/vocabulary.resolver.js';

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
    controllers: [HealthController, RecordingsController, JobsController, LiveController],
    providers: [
      RecordingsService,
      EventsConsumer,
      RecordingsResolver,
      JobsResolver,
      TranscriptsResolver,
      VocabularyResolver,
      SettingsResolver,
    ],
  })
  class AppModule {}
  return AppModule;
}
