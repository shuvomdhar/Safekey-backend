import type { NextFunction, Request, Response } from 'express';
import { isRaised, supabaseAdmin, unwrap } from '../db.js';
import { ApiError } from '../lib/http.js';
import { verifySupabaseAccessToken, type SupabaseIdentity } from '../lib/supabase.js';

export type AuthUser = {
  id: number;
  supabase_user_id: string;
  email: string;
  full_name: string | null;
  has_password: boolean;
  has_google: boolean;
  status: 'active' | 'inactive' | 'archived';
  created_at: string;
};

const USER_COLUMNS = 'id, supabase_user_id, email, full_name, has_password, has_google, status, created_at';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Resolve a verified Supabase identity to the Safekey `users` row.
 *
 * Supabase owns email/password and Google identities. `api_resolve_user` links
 * (or creates) the matching Safekey row atomically, so the rest of the app can
 * keep using integer IDs and `user_id` scoping.
 */
async function resolveUser(identity: SupabaseIdentity): Promise<AuthUser> {
  try {
    const user = unwrap(
      await supabaseAdmin.rpc('api_resolve_user', {
        p_supabase_user_id: identity.id,
        p_email: identity.email,
        p_full_name: identity.fullName,
        p_has_password: identity.providers.includes('email'),
        p_has_google: identity.providers.includes('google')
      })
    ) as unknown as AuthUser | null;

    if (!user) {
      throw new ApiError(500, 'ACCOUNT_RESOLVE_FAILED', 'Could not load your account.');
    }

    return user;
  } catch (error) {
    if (isRaised(error, 'IDENTITY_CONFLICT')) {
      // A new identity (for example Google) using the email of a deleted
      // account is refused with the deleted-account message, not a sign-in
      // conflict, because that email can never be reused.
      const profile = unwrap(
        await supabaseAdmin
          .from('users')
          .select('id, status')
          .eq('email', identity.email)
          .maybeSingle()
      ) as { id: number; status: 'active' | 'inactive' | 'archived' } | null;

      if (profile?.status === 'archived') {
        throw new ApiError(
          403,
          'ACCOUNT_ARCHIVED',
          'This account has been deleted. An account cannot be created again with the same email.'
        );
      }

      throw new ApiError(
        409,
        'IDENTITY_CONFLICT',
        'This email is already linked to a different sign-in. Use that method instead.'
      );
    }

    if (isRaised(error, 'ACCOUNT_CONFLICT')) {
      throw new ApiError(
        409,
        'ACCOUNT_CONFLICT',
        'That email is already in use. Sign in with your existing method instead.'
      );
    }

    throw error;
  }
}

/**
 * Every API request carries `Authorization: Bearer <supabase-access-token>`.
 * The token is verified with Supabase Auth on each request; forged or expired
 * tokens are rejected before any route handler runs.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Please sign in to continue.');
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Please sign in to continue.');
    }

    const identity = await verifySupabaseAccessToken(token);
    const user = await resolveUser(identity);

    // Deleted accounts are archived. The email stays reserved, so the account
    // cannot be recreated with the same address.
    if (user.status === 'archived') {
      throw new ApiError(
        403,
        'ACCOUNT_ARCHIVED',
        'This account has been deleted. An account cannot be created again with the same email.'
      );
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}
