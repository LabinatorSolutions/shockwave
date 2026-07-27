import { defineConfig } from 'drizzle-kit';

// Drizzle-kit config. `drizzle-kit push` syncs schema.ts to the database (dev);
// `drizzle-kit generate` emits SQL migrations under ./drizzle for prod. The
// boot-time ensureSchema (init.sql) remains the idempotent bootstrap so a fresh
// Postgres volume comes up without a kit step.
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
