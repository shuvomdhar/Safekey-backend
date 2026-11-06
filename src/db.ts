import { createClient, type PostgrestError } from '@supabase/supabase-js';
import { env } from './env.js';

/**
 * Server-side Supabase client.
 *
 * Every Safekey read/write goes through this client using the service-role key
 * (server only). There is no direct Postgres connection: Supabase exposes the
 * tables over its REST API and the `api_*` RPC functions in `db/schema.sql`.
 * Row-level security stays enabled, so anon/authenticated clients can never
 * read the tables directly.
 */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  },
  global: {
    headers: { 'X-Client-Info': 'safekey-api' }
  }
});

/** Wraps a PostgREST error so routes can inspect it without losing details. */
export class DbError extends Error {
  readonly postgrest: PostgrestError;

  constructor(error: PostgrestError) {
    super(error.message);
    this.name = 'DbError';
    this.postgrest = error;
  }
}

type DbResponse<T> = { data: T | null; error: PostgrestError | null };

/** Throw a `DbError` when Supabase reports one, otherwise return the data. */
export function unwrap<T>(result: DbResponse<T>): T | null {
  if (result.error) throw new DbError(result.error);
  return result.data;
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof DbError && error.postgrest.code === '23505';
}

/**
 * Postgres functions in `schema.sql` raise `P0001` with a stable marker
 * (for example `COLUMN_LIMIT_REACHED`) so routes can map them to a friendly
 * API error.
 */
export function isRaised(error: unknown, marker: string): boolean {
  return (
    error instanceof DbError &&
    error.postgrest.code === 'P0001' &&
    error.postgrest.message.startsWith(marker)
  );
}
