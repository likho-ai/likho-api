import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` writes a SQL migration for what changed in src/db/schema.ts.
// The service applies the migrations in src/db/migrations when it starts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://likho_api:likho_api@localhost:5433/likho_api' },
});
