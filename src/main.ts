import 'reflect-metadata';
import { createApp, log } from './app.js';
import { loadConfig } from './config/config.js';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.HTTP_PORT);
log.log(
  `likho-api 0.3.0: HTTP on ${config.HTTP_PORT} (/graphql, /api/v1, /api/docs, /events), consumers ${config.CONSUMERS_ENABLED ? 'on' : 'off'}`,
);
