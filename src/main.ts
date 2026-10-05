import 'reflect-metadata';
import { createApp, log } from './app.js';
import { loadConfig } from './config/config.js';
import { VERSION } from './version.js';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.HTTP_PORT);
log.log(
  `likho-api ${VERSION}: HTTP on ${config.HTTP_PORT} (/graphql, /api/v1, /api/docs, /events, /metrics), consumers ${config.CONSUMERS_ENABLED ? 'on' : 'off'}`,
);
