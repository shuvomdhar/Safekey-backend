import { createApp } from './app.js';
import { env } from './env.js';
import { supabaseAdmin } from './db.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.info(`\n  Safekey API listening on http://localhost:${env.PORT}`);
  console.info(`  Frontend: ${env.FRONTEND_URL}`);
  console.info(`  Environment: ${env.NODE_ENV}\n`);
});

// Fail loudly (but only in the log) if Supabase is unreachable or the schema
// has not been applied yet.
async function checkSupabase() {
  try {
    const { error } = await supabaseAdmin
      .from('users')
      .select('id', { head: true, count: 'exact' })
      .limit(1);

    if (error) {
      console.error('[supabase] Could not read the Safekey tables. Did you run db/schema.sql?');
      console.error(`[supabase] ${error.message}`);
      return;
    }

    console.info('[supabase] Connected to the Supabase project.');
  } catch (error) {
    console.error('[supabase] Could not reach Supabase.');
    console.error(`[supabase] ${error instanceof Error ? error.message : error}`);
  }
}

void checkSupabase();

function shutdown(signal: string) {
  console.info(`\n[api] ${signal} received — shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
