import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { supabaseAdmin, unwrap } from '../db.js';
import { isProduction } from '../env.js';
import { ApiError } from '../lib/http.js';
import { requireAuth, type AuthUser } from '../middleware/auth.js';
import { emailSchema, passwordSchema } from '../lib/validation.js';

export const authRouter = Router();

const publicUser = (user: AuthUser) => ({
  id: user.id,
  email: user.email,
  fullName: user.full_name,
  hasPassword: user.has_password,
  hasGoogle: user.has_google,
  createdAt: user.created_at
});

const USER_COLUMNS = 'id, supabase_user_id, email, full_name, has_password, has_google, status, created_at';

type ProfileByEmail = {
  id: number;
  status: 'active' | 'archived';
  supabase_user_id: string | null;
};

/**
 * Password recovery is intentionally email-match-only: no reset mail is sent.
 * A caller who knows an email can therefore replace that account's password, so
 * the public endpoints get a much tighter budget than the rest of the API.
 */
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction ? 10 : 1_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many password reset attempts. Please wait a few minutes and try again.'
    }
  }
});

async function fetchUser(userId: number): Promise<AuthUser> {
  const user = unwrap(
    await supabaseAdmin.from('users').select(USER_COLUMNS).eq('id', userId).maybeSingle()
  ) as AuthUser | null;

  if (!user) {
    throw new ApiError(404, 'NOT_FOUND', 'That account does not exist.');
  }

  return user;
}

/**
 * GET /api/auth/me — the Safekey profile behind the verified Supabase session.
 * `requireAuth` creates (or links) the local row on the first request.
 */
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user!) });
});

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z
    .string()
    .trim()
    .max(80, 'Names can be at most 80 characters.')
    .nullable()
    .optional()
});

/**
 * Find an existing Supabase Auth user by email. Only used when registration
 * hits "already registered" so an unconfirmed signup can be completed instead
 * of leaving the email permanently stuck.
 */
async function findAuthUserByEmail(email: string) {
  const target = email.toLowerCase();

  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;

    const found = data.users.find((user) => user.email?.toLowerCase() === target);
    if (found) return found;
    if (data.users.length < 1000) return null;
  }

  return null;
}

/**
 * Find the Safekey profile for an email, including archived (deleted) rows.
 * Used by registration to explain that a deleted account's email is reserved,
 * and by password recovery to target the matching Supabase identity.
 */
async function findProfileByEmail(email: string): Promise<ProfileByEmail | null> {
  const { data } = await supabaseAdmin
    .from('users')
    .select('id, status, supabase_user_id')
    .eq('email', email)
    .maybeSingle();

  return data as ProfileByEmail | null;
}

/**
 * POST /api/auth/register — create the Supabase Auth user with a confirmed
 * email. This is called before the browser has a session.
 *
 * Using the admin API here makes registration independent of the project's
 * "Confirm email" setting, which otherwise makes `signUp` return no session.
 * The browser signs in with `signInWithPassword` immediately afterwards.
 */
authRouter.post('/register', async (req, res) => {
  const body = registerSchema.parse(req.body);
  const fullName = body.fullName?.trim() || null;

  // A deleted account keeps its email. Refuse up front so no orphan Supabase
  // identity is created for an address that can never be used again.
  const profile = await findProfileByEmail(body.email);

  if (profile?.status === 'archived') {
    throw new ApiError(
      409,
      'ACCOUNT_DELETED',
      'This email belongs to a deleted account. Deleted accounts cannot be recreated with the same email — use a different email address.'
    );
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { full_name: fullName }
  });

  if (error) {
    const message = error.message.toLowerCase();

    if (
      message.includes('already been registered') ||
      message.includes('already registered') ||
      message.includes('email exists') ||
      message.includes('user already exists')
    ) {
      const existing = await findAuthUserByEmail(body.email);

      // Finish a previous signup that never got a session. Confirmed accounts
      // are never touched, so an existing account cannot be taken over here.
      if (existing && !existing.email_confirmed_at) {
        const { data: updated, error: updateError } =
          await supabaseAdmin.auth.admin.updateUserById(existing.id, {
            password: body.password,
            email_confirm: true,
            user_metadata: { full_name: fullName }
          });

        if (!updateError && updated.user) {
          res.status(201).json({
            user: { id: updated.user.id, email: updated.user.email }
          });
          return;
        }
      }

      throw new ApiError(
        409,
        'EMAIL_TAKEN',
        'An account already exists with this email. Sign in instead, or use the forgot-password flow.'
      );
    }

    console.error('[auth] Supabase could not create the user:', error.message);
    throw new ApiError(
      502,
      'SUPABASE_UNAVAILABLE',
      'Could not create your account right now. Please try again.'
    );
  }

  if (!data.user) {
    throw new ApiError(502, 'SUPABASE_UNAVAILABLE', 'Supabase did not return the new account.');
  }

  res.status(201).json({
    user: { id: data.user.id, email: data.user.email }
  });
});

const updateProfileSchema = z.object({
  fullName: z
    .string()
    .trim()
    .max(80, 'Names can be at most 80 characters.')
    .nullable()
    .optional()
});

/** PATCH /api/auth/me — update the display name. */
authRouter.patch('/me', requireAuth, async (req, res) => {
  const body = updateProfileSchema.parse(req.body);
  const user = req.user!;

  if (body.fullName !== undefined) {
    unwrap(
      await supabaseAdmin
        .from('users')
        .update({ full_name: body.fullName?.trim() ? body.fullName.trim() : null })
        .eq('id', user.id)
    );
  }

  const updated = await fetchUser(user.id);
  res.json({ user: publicUser(updated) });
});

/**
 * POST /api/auth/password-set — called by the browser after it successfully
 * sets a password through `supabase.auth.updateUser`. Supabase remains the
 * source of truth for credentials; this only records the capability locally so
 * Settings can label the email/password method correctly.
 */
authRouter.post('/password-set', requireAuth, async (req, res) => {
  const updated = unwrap(
    await supabaseAdmin
      .from('users')
      .update({ has_password: true })
      .eq('id', req.user!.id)
      .select(USER_COLUMNS)
      .maybeSingle()
  ) as AuthUser | null;

  if (!updated) {
    throw new ApiError(404, 'NOT_FOUND', 'That account does not exist.');
  }

  res.json({ user: publicUser(updated) });
});

const resetEmailSchema = z.object({ email: emailSchema });
const resetPasswordSchema = z.object({
  email: emailSchema,
  password: passwordSchema
});

/**
 * POST /api/auth/password-reset/check — public.
 *
 * Step one of the email-match-only recovery flow: confirm that an active
 * Safekey account uses this address. No email is sent and no token is created.
 *
 * A brand-new registration creates the Supabase identity before the browser's
 * first `/me` call, so the profile row may not exist yet. In that case the
 * matching Supabase identity is enough.
 */
authRouter.post('/password-reset/check', resetLimiter, async (req, res) => {
  const body = resetEmailSchema.parse(req.body);
  const profile = await findProfileByEmail(body.email);

  if (profile?.status === 'archived') {
    throw new ApiError(
      403,
      'ACCOUNT_ARCHIVED',
      'This account has been deleted. An account cannot be created again with the same email.'
    );
  }

  if (!profile) {
    const identity = await findAuthUserByEmail(body.email);

    if (!identity) {
      throw new ApiError(
        404,
        'ACCOUNT_NOT_FOUND',
        'No Safekey account uses that email address.'
      );
    }
  }

  res.json({ ok: true });
});

/**
 * POST /api/auth/password-reset — public.
 *
 * Step two: the entered email matched an active account, so set a new password
 * directly through the Supabase admin API. No confirmation mail is involved.
 *
 * This is deliberately weaker than the usual mailed single-use link: possession
 * of the email address is the only proof required, which is why the route is
 * rate limited and why the UI makes the trade-off explicit.
 */
authRouter.post('/password-reset', resetLimiter, async (req, res) => {
  const body = resetPasswordSchema.parse(req.body);
  const profile = await findProfileByEmail(body.email);

  if (profile?.status === 'archived') {
    throw new ApiError(
      403,
      'ACCOUNT_ARCHIVED',
      'This account has been deleted. An account cannot be created again with the same email.'
    );
  }

  // Profiles normally store the identity that `api_resolve_user` linked. Fall
  // back to a directory lookup for rows created before that column was filled,
  // or for an account that registered but has not called `/me` yet.
  const identity = profile?.supabase_user_id
    ? null
    : await findAuthUserByEmail(body.email);
  const identityId = profile?.supabase_user_id ?? identity?.id ?? null;

  if (!profile && !identityId) {
    throw new ApiError(
      404,
      'ACCOUNT_NOT_FOUND',
      'No Safekey account uses that email address.'
    );
  }

  if (!identityId) {
    throw new ApiError(
      502,
      'RESET_UNAVAILABLE',
      'This account has no email/password sign-in configured. Contact support.'
    );
  }

  const { error } = await supabaseAdmin.auth.admin.updateUserById(identityId, {
    password: body.password,
    email_confirm: true
  });

  if (error) {
    console.error('[auth] Supabase could not reset the password:', error.message);
    throw new ApiError(
      502,
      'SUPABASE_UNAVAILABLE',
      'Could not update your password right now. Please try again.'
    );
  }

  if (profile) {
    unwrap(
      await supabaseAdmin
        .from('users')
        .update({ has_password: true, supabase_user_id: identityId })
        .eq('id', profile.id)
        .eq('status', 'active')
    );
  } else {
    // The account registered but never loaded its profile. Resolve it now so
    // the next sign-in lands on a complete Safekey row.
    const metadata = (identity?.user_metadata ?? {}) as { full_name?: string };
    const providers = identity?.app_metadata?.providers ?? [];

    unwrap(
      await supabaseAdmin.rpc('api_resolve_user', {
        p_supabase_user_id: identityId,
        p_email: body.email,
        p_full_name: metadata.full_name ?? null,
        p_has_password: true,
        p_has_google: Array.isArray(providers) && providers.includes('google')
      })
    );
  }

  res.status(204).end();
});

const deleteAccountSchema = z.object({ confirmEmail: emailSchema });

/**
 * DELETE /api/auth/me — soft-delete the account.
 *
 * The profile and its vaults stay in Supabase with `status = 'archived'`, and
 * the Supabase identity is kept. The email is therefore reserved: it cannot be
 * used to create a new account, and `requireAuth` refuses it from now on.
 */
authRouter.delete('/me', requireAuth, async (req, res) => {
  const body = deleteAccountSchema.parse(req.body);
  const user = req.user!;

  if (body.confirmEmail !== user.email.toLowerCase()) {
    throw new ApiError(400, 'EMAIL_MISMATCH', 'Type your email address exactly to confirm.');
  }

  unwrap(
    await supabaseAdmin
      .from('users')
      .update({ status: 'archived', archived_at: new Date().toISOString() })
      .eq('id', user.id)
      .eq('status', 'active')
  );

  res.status(204).end();
});
