import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { CONFIG, type Config } from '../config/config.js';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('db');
  readonly pool: pg.Pool;
  readonly db: Db;

  constructor(@Inject(CONFIG) config: Config) {
    this.pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
    this.db = drizzle({ client: this.pool, schema, casing: 'snake_case' });
  }

  /** Creates or updates the tables. Safe when several instances start together. */
  async onModuleInit(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(hashtext('likho-api-migrate'))`);
      // The record of applied migrations lives in the schema being migrated (tests use their own).
      const { rows } = await client.query<{ schema: string }>('SELECT current_schema() AS schema');
      await migrate(drizzle({ client, schema, casing: 'snake_case' }), {
        migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), 'migrations'),
        migrationsSchema: rows[0]?.schema ?? 'public',
      });
      await client.query(`SELECT pg_advisory_unlock(hashtext('likho-api-migrate'))`);
    } finally {
      client.release();
    }
    this.log.log('database ready');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }
}

@Global()
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
