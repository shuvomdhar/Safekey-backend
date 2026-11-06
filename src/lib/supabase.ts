import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { env } from '../env.js';
import { ApiError } from './http.js';

/**
 * Server-side Supabase Auth client used only to verify the access token that
 * the browser received from Supabase Auth. Data access uses `supabaseAdmin`
 * with the service-role key; the public anon key is enough for token checks.
 */
const supabaseAuth = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false
  }
});

const supabaseUserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email().nullable().optional(),
    app_metadata: z
      .object({
        provider: z.string().optional(),
        providers: z.array(z.string()).optional()
      })
      .passthrough()
      .optional(),
    identities: z
      .array(
        z
          .object({
            provider: z.string().optional()
          })
          .passthrough()
      )
      .nullable()
      .optional(),
    user_metadata: z
      .object({
        full_name: z.string().nullish(),
        name: z.string().nullish(),
        email_verified: z.boolean().nullish()
      })
      .passthrough()
      .optional()
  })
  .passthrough();

export type SupabaseIdentity = {
  id: string;
  email: string;
  fullName: string | null;
  providers: string[];
};

function cleanName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 80);
}

/**
 * Verify a Supabase access token with Supabase itself. `getUser` checks the
 * token signature, expiry and revocation status, and returns the current user
 * including every linked identity.
 */
export async function verifySupabaseAccessToken(accessToken: string): Promise<SupabaseIdentity> {
  let result: Awaited<ReturnType<typeof supabaseAuth.auth.getUser>>;

  try {
    result = await supabaseAuth.auth.getUser(accessToken);
  } catch {
    throw new ApiError(
      502,
      'SUPABASE_UNAVAILABLE',
      'Could not reach Supabase to verify your session. Please try again.'
    );
  }

  const { data, error } = result;

  if (error || !data.user) {
    // Supabase returns a 4xx for expired/revoked/forged tokens. Anything else
    // is treated as an upstream failure so the client can retry.
    const status = error?.status;
    if (status === undefined || status === 400 || status === 401 || status === 403) {
      throw new ApiError(
        401,
        'INVALID_SESSION',
        'Your session has expired. Please sign in again.'
      );
    }

    throw new ApiError(
      502,
      'SUPABASE_UNAVAILABLE',
      'Supabase could not verify your session right now. Please try again.'
    );
  }

  const parsed = supabaseUserSchema.safeParse(data.user);
  if (!parsed.success) {
    throw new ApiError(401, 'INVALID_SESSION', 'Supabase returned an unexpected account.');
  }

  const user = parsed.data;
  const providers = new Set(
    [
      user.app_metadata?.provider,
      ...(user.app_metadata?.providers ?? []),
      ...(user.identities ?? []).map((identity) => identity.provider)
    ].filter((provider): provider is string => Boolean(provider))
  );

  const email = user.email?.trim().toLowerCase();
  if (!email) {
    throw new ApiError(401, 'EMAIL_MISSING', 'That sign-in method did not share an email address.');
  }

  return {
    id: user.id,
    email,
    fullName: cleanName(user.user_metadata?.full_name) ?? cleanName(user.user_metadata?.name),
    providers: [...providers]
  };
}
