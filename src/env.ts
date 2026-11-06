import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  // 64 hex characters = 32 bytes. Used for AES-256-GCM field encryption.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),

  FRONTEND_URL: z.string().url().default('http://localhost:3000'),

  // Supabase Auth owns sign-up, sign-in, Google OAuth and password resets.
  // The anon key is public and only verifies browser access tokens.
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),

  // Server-only key used for every data read/write through Supabase.
  // Never expose this to the browser. Supabase → Project Settings → API.
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1, 'SUPABASE_SERVICE_ROLE_KEY is required')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  • ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(
    `\nInvalid environment configuration:\n${issues}\n\nCheck backend/.env (see .env.example).\n`
  );
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';

/** Supabase Auth is required for every sign-in method. */
export const supabaseAuthConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY);
