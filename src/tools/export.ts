/**
 * Writes what other repositories build against:
 *   schema.graphql                              the GraphQL schema (likho-web-sdk generates its client from it)
 *   openapi.json                                the REST description
 *   postman/likho-api.postman_collection.json   the same, as a Postman collection
 *
 * Starts the application once (it needs the local stack), so run:  pnpm export
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { printSchema } from 'graphql';
import { mkdir, writeFile } from 'node:fs/promises';
import converter from 'openapi-to-postmanv2';
import { appModule } from '../app.module.js';
import { loadConfig } from '../config/config.js';

const config = loadConfig({ ...process.env, CONSUMERS_ENABLED: 'false' });
const app = await NestFactory.create(appModule(config), { logger: ['warn', 'error'] });
await app.init();

const schema = app.get(GraphQLSchemaHost).schema;
// The same bytes the service writes on a development start (NestJS's header, no trailing
// newline), so the committed file never drifts between the two.
const HEADER =
  '# ------------------------------------------------------\n' +
  '# THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)\n' +
  '# ------------------------------------------------------\n\n';
await writeFile('schema.graphql', HEADER + printSchema(schema));
console.log('schema.graphql written');

const document = SwaggerModule.createDocument(
  app,
  new DocumentBuilder()
    .setTitle('Likho API')
    .setDescription('Recordings, jobs and transcripts for scripts and connectors. Browsers use /graphql.')
    .setVersion('1')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description: 'An API key from the settings page (lk_...)',
    })
    .addServer('http://localhost:8080', 'The local gateway')
    .build(),
);
await writeFile('openapi.json', JSON.stringify(document, null, 2) + '\n');
console.log('openapi.json written');

const collection = await new Promise<object>((resolve, reject) => {
  converter.convert(
    { type: 'json', data: document as never },
    { folderStrategy: 'Tags', requestNameSource: 'Fallback', includeAuthInfoInExample: true },
    (error, result) => {
      if (error) reject(new Error(error.message));
      else if (!result?.result || !result.output?.[0])
        reject(new Error(result?.reason ?? 'conversion failed'));
      else resolve(result.output[0].data);
    },
  );
});
await mkdir('postman', { recursive: true });
await writeFile('postman/likho-api.postman_collection.json', JSON.stringify(collection, null, 2) + '\n');
console.log('postman/likho-api.postman_collection.json written');

await app.close();
