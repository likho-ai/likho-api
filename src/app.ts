/** Builds the application the same way for the real process and for tests. */
import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  INestApplication,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Response } from 'express';
import { appModule } from './app.module.js';
import { LikhoError } from './common/errors.js';
import { Config } from './config/config.js';

/** REST errors always look like {"error": {"code", "message"}}, GraphQL ones are formatted elsewhere. */
@Catch(HttpException)
class RestErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    if (host.getType<'graphql' | 'http'>() !== 'http') throw exception;
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    if (exception instanceof LikhoError) {
      response.status(status).json(exception.getResponse());
      return;
    }
    const body = exception.getResponse() as { message?: string | string[] };
    const message = Array.isArray(body.message)
      ? body.message.join('; ')
      : (body.message ?? exception.message);
    const code =
      exception instanceof BadRequestException
        ? 'invalid'
        : status === 404
          ? 'not_found'
          : status === 401
            ? 'unauthenticated'
            : status === 403
              ? 'forbidden'
              : 'error';
    response.status(status).json({ error: { code, message } });
  }
}

export async function createApp(config?: Config): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(appModule(config), {
    logger: ['log', 'warn', 'error'],
  });
  // The vocabulary CSV endpoints take the file as the body.
  app.useBodyParser('text', { type: ['text/csv', 'text/plain'], limit: '5mb' });
  app.useGlobalPipes(
    new ValidationPipe({
      // GraphQL refuses unknown fields itself; whitelisting would strip the fields of input types.
      whitelist: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new RestErrorFilter());
  app.enableShutdownHooks();

  const openapi = new DocumentBuilder()
    .setTitle('Likho API')
    .setDescription('Recordings, jobs and transcripts for scripts and connectors. Browsers use /graphql.')
    .setVersion('1')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description: 'An API key from the settings page (lk_...)',
    })
    .build();
  const document = SwaggerModule.createDocument(app, openapi);
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });
  return app;
}

export const log = new Logger('likho-api');
