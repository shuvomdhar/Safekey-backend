# Safekey

A calm, flexible password and secret manager. Create a **vault** for every site or topic, design the **columns** each vault needs, and keep every account for that site together.

Built with **Next.js + TypeScript** on the front, **Node + Express** on the back, and **Supabase** for storage. The interface uses a warm cream-and-olive palette (`#FAF7EE` / `#31372B`).

---

## Contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Quick start](#quick-start)
- [Supabase setup](#supabase-setup)
- [Google sign-in setup](#google-sign-in-setup)
- [Password reset email setup](#password-reset-email-setup)
- [Environment variables](#environment-variables)
- [How Safekey works](#how-safekey-works)
- [API reference](#api-reference)
- [Database schema](#database-schema)
- [Scripts](#scripts)
- [Production notes](#production-notes)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Limitations and next steps](#limitations-and-next-steps)

---

## Features

### Vaults and entries

- **Custom vaults ("folders")** — one for Instagram, one for banking, one for API keys. Each has a name, optional description, colour, and icon.
- **Custom columns** — every vault defines its own fields. Start from a template or build from scratch:
  - Types: `text`, `password`, `email`, `username`, `url`, `note`, `number`, `date`
  - Mark fields as **secret** and/or **required**
  - Rename, retype, reorder (drag-free ordering controls), and delete columns
  - Up to **20 columns per vault**
  - Toggling secrecy **re-encrypts or decrypts existing values transactionally**
- **Multiple accounts per site** — an entry is a row inside a vault, so a single "Instagram" vault can hold Personal, Studio and Shop accounts side by side.
- **Entry search** — filter vaults instantly, and search entry titles, notes and visible field values across every vault from the dashboard. Server-side and scoped to the signed-in owner.
- **Templates** — `blank`, `login`, `social`, `api`, `banking`, `identity`.
- **Masked by default** — secret values are never included in list or item responses. They are revealed one field at a time through a dedicated endpoint, and the UI auto-hides them after 20 seconds.
- **Archived deletes** — deleting an entry or vault hides it from the app immediately, while the database keeps it with `status = 'archived'`. Vaults start as `failed` while being created and become `active` only after all template columns are written.

### Accounts

- **Supabase Auth owns every credential** — email/password, Google OAuth, sessions and hashing. Safekey never stores a password hash or a reset token.
- Email + password registration with **no email confirmation** (signs in immediately).
- **Google sign-in through Supabase Auth** (PKCE OAuth).
- Automatic Google linking when the verified Google email matches an existing account.
- **Forgot-password flow without email** — enter the account email; if it matches an active account, set a new password directly.
- **Set a password** from Settings if the account was created with Google only.
- **Change password** through Supabase, with the current password checked first when one exists.
- Editable display name; avatars are generated from initials.
- **Delete account** with email confirmation; the profile is archived and the email address can never be used to create another account.
- Browser-held Supabase session: the access token is sent as `Authorization: Bearer …` on every API request and refreshed automatically.

### Interface

- Landing page, sign-in, registration, forgot/reset password.
- Responsive dashboard with sidebar on desktop and compact header on mobile.
- Vault grid with quick templates, entry table, slide-over entry drawer, column manager, confirm dialogs, toasts.
- Settings page for profile, password, sign-in methods, session, and account deletion.
- Accessible primitives (labels, `aria-invalid`, focus rings) and reduced-motion support.

---

## Tech stack

| Layer      | Choice                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Frontend   | Next.js 16 (App Router, Turbopack, Cache Components), React 19, TypeScript |
| Styling    | Tailwind CSS v4 theme tokens, Fraunces + Inter via `next/font`, lucide-react |
| Backend    | Node.js 20+, Express 5, TypeScript, Zod validation                      |
| Database   | Supabase (tables + RPC functions via `@supabase/supabase-js`, service-role key server-side) |
| Auth       | Supabase Auth (email/password + Google OAuth); bearer access tokens verified by the API |
| Encryption | Node `crypto`, AES-256-GCM with per-field AAD                          |
| Email      | Not required — password recovery is email-match-only and sends no mail |

---

## Architecture

```
┌─────────────────────────────────────────────┐
│ Browser                                     │
│  Next.js pages (React client components)    │
│  @supabase/supabase-js ──► Supabase Auth    │
│  session kept in the browser                │
│  fetch("/api/…") + Bearer access token      │
└───────────────────┬─────────────────────────┘
                    │ same-origin /api rewrite
┌───────────────────▼─────────────────────────┐
│ Next.js server (port 3000)                  │
│  /                     landing              │
│  /login /register /forgot-password …        │
│  /auth/callback  Supabase OAuth return      │
│  /dashboard /dashboard/folders/[id] …       │
│  /api/:path*  ── rewrite ──► Express        │
└───────────────────┬─────────────────────────┘
                    │ server-to-server
┌───────────────────▼─────────────────────────┐
│ Express API (port 4000)                     │
│  auth · folders · columns · items           │
│  verifies bearer tokens with Supabase Auth  │
│  AES-256-GCM field encryption               │
└───────────────────┬─────────────────────────┘
                    │ Supabase REST + RPC (service role)
┌───────────────────▼─────────────────────────┐
│ Supabase                                    │
│  Auth (email/password, Google, resets)      │
│  public tables + `api_*` RPC functions      │
│  users · folders · folder_columns           │
│  folder_items · item_values                 │
└─────────────────────────────────────────────┘
```

**Supabase Auth owns identity.** The browser signs up, signs in (password or
Google), resets passwords, and refreshes sessions directly with Supabase. The
Express API verifies each request's `Authorization: Bearer <access_token>` with
Supabase's `/auth/v1/user` endpoint, then maps that verified identity to the
integer-ID `users` row used by every other table.

**Supabase owns storage.** The API never opens a Postgres connection. It talks
to Supabase with the server-only service-role key: simple reads/writes use the
table API and multi-step operations use `api_*` RPC functions defined in
`backend/db/schema.sql`. Row-level security is enabled on every table and no
policies are granted to anon/authenticated, so only the API's service-role key
can reach the data. AES-256-GCM encryption and decryption still happen in Node
before values are sent to Supabase.

The browser only talks to the Next.js origin for application data. The `/api/*`
rewrite proxies to Express, so the API can stay private on the network while the
Access-Control-Allow-Origin setup remains simple.

---

## Project structure

```
Safekey/
├─ package.json                 # convenience scripts for both apps
├─ scripts/dev.mjs              # starts API + web together, cleans up children
├─ README.md
│
├─ backend/
│  ├─ db/schema.sql             # idempotent Supabase schema, RLS and api_* RPCs
│  ├─ src/
│  │  ├─ app.ts                 # Express app, CORS, rate limits, route mounts
│  │  ├─ index.ts               # server bootstrap + graceful shutdown
│  │  ├─ env.ts                 # Zod-validated environment
│  │  ├─ db.ts                  # Supabase service-role client + error helpers
│  │  ├─ lib/                   # crypto, Supabase token verification, templates, validation
│  │  ├─ middleware/            # bearer-token auth guard, errors
│  │  └─ routes/                # auth (profile), folders, columns, items
│  ├─ .env.example
│  └─ package.json
│
└─ frontend/
   ├─ app/
   │  ├─ page.tsx               # landing
   │  ├─ (auth)/                # login, register, forgot, reset, auth/callback
   │  └─ dashboard/             # overview, folders/[id], settings
   ├─ components/               # UI, auth, dashboard, folders, items
   ├─ lib/                      # API client, auth context, Supabase client, types
   ├─ next.config.ts            # /api rewrite proxy
   ├─ .env.example
   └─ package.json
```

---

## Quick start

### Prerequisites

- **Node.js 20.9+** and npm
- A **Supabase** project with **Authentication** enabled (email provider on; the API confirms new users itself, so the Confirm email setting does not block registration)
- Optional: **Google OAuth** configured in Supabase for Google sign-in
- Optional: custom **SMTP** configured inside Supabase only if you enable other email features; password recovery does not use email

### 1. Install dependencies

From the repository root:

```bash
npm run install:all
```

This installs `backend/` and `frontend/` separately. The root itself has no runtime dependencies.

### 2. Create the environment files

```bash
# macOS / Linux
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# Windows PowerShell
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
```

Generate the encryption key:

```bash
npm run keygen   # paste into ENCRYPTION_KEY
```

`ENCRYPTION_KEY` must be exactly **64 hex characters** (32 bytes). Keep it safe: if it changes, previously stored secrets cannot be decrypted.

Set at minimum in `backend/.env`:

```dotenv
ENCRYPTION_KEY=…64 hex characters…
FRONTEND_URL=http://localhost:3000
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=eyJ…
SUPABASE_SERVICE_ROLE_KEY=eyJ…
```

Get the **service_role** secret from **Supabase → Project Settings → API**. It is
server-only: never put it in `frontend/.env`, a browser bundle, or source
control.

Set in `frontend/.env`:

```dotenv
BACKEND_URL=http://localhost:4000
NEXT_PUBLIC_API_URL=
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ…
```

Both apps must use the **same Supabase project**. The anon key is public by
design; the API uses it only as the `apikey` header when verifying a bearer
token. All data access uses `SUPABASE_SERVICE_ROLE_KEY` through
`@supabase/supabase-js` — there is no direct Postgres connection.

### 3. Create the database tables and RPC functions

Open **Supabase → SQL Editor**, paste the contents of `backend/db/schema.sql`,
and run it. The schema is idempotent, so running it again after a code update is
safe. It creates the tables, enables RLS, and installs the `api_*` functions
used by the API.

Verify the API can reach the database:

```bash
curl http://localhost:4000/api/health
```

### 4. Run both apps

```bash
npm run dev
```

- Web: <http://localhost:3000>
- API: <http://localhost:4000>
- Health: <http://localhost:4000/api/health>

Or run them in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

### 5. Create your first account

Open <http://localhost:3000/register>. Registration uses Supabase Auth and signs you in immediately — no confirmation email is sent or required. Create a vault, add a column set, and start adding entries.

> If port 3000 is busy, Next.js may start on 3001. Update `FRONTEND_URL` in `backend/.env` and the Supabase redirect URLs to match, otherwise CORS, OAuth and reset redirects point at the wrong place.

---

## Supabase setup

Safekey uses one Supabase project for two things:

- **Storage** — tables and `api_*` RPC functions, reached with the service-role
  key through `@supabase/supabase-js`.
- **Supabase Auth** — owns email/password, Google OAuth, sessions and password hashing. Safekey resets passwords through the admin API, without email.

### Storage

1. Create a project at <https://supabase.com>.
2. Open **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL` (backend) and `NEXT_PUBLIC_SUPABASE_URL` (frontend).
   - **anon public** key → `SUPABASE_ANON_KEY` (backend) and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (frontend).
   - **service_role** secret → `SUPABASE_SERVICE_ROLE_KEY` (backend only).
3. Open **SQL Editor**, paste `backend/db/schema.sql`, and run it.
4. Confirm the API can reach Supabase: `GET http://localhost:4000/api/health`.

There is **no `DATABASE_URL` and no `pg` driver**. The API does not connect to
Postgres directly; it calls Supabase's REST API and RPC functions. The
service-role key is required server-side and must never be shipped to the
browser.

The schema enables **Row Level Security** on `users`, `folders`,
`folder_columns`, `folder_items`, and `item_values`, and defines no policies for
`anon`/`authenticated`. Execute permission on the `api_*` functions is revoked
from those roles and granted only to `service_role`. That keeps the public anon
key — which is visible in the browser — unable to read vault data.

### Authentication

1. Open **Authentication → Providers → Email**.
2. Turn on **Enable Email Provider**.
3. **Confirm email** can stay off (recommended) or on. Safekey registration
   calls `POST /api/auth/register`, which creates the Supabase user with
   `email_confirm: true` using the service-role key. The browser then signs in
   with the same email/password, so registration never waits for a confirmation
   email and does not depend on this toggle.
4. Open **Authentication → URL Configuration**:
   - **Site URL**: `http://localhost:3000` in development, your production URL otherwise.
   - **Redirect URLs**: add every app callback:
     ```
     http://localhost:3000/auth/callback
     https://safekey.example.com/auth/callback
     ```
     Add `http://localhost:3001/auth/callback` only if you actually use that port.
5. Password recovery does **not** send email. Supabase's SMTP settings are only
   needed for other project emails; the forgot-password flow checks the address
   and updates the password through the API.

> **Upgrading from an older Safekey database:** earlier versions used UUID
> primary keys and Safekey-owned bcrypt/JWT authentication. All IDs are now
> 32-bit integers, and credentials live in Supabase Auth. `schema.sql` refuses
> to run against a UUID schema, drops the old `password_hash`/`token_version`
> columns, and removes `password_reset_tokens`. Back up any data you need,
> drop/recreate the database, then run `backend/db/schema.sql` again. Users with
> old Safekey passwords must sign up again in Supabase or use
> **Forgot password** to set one.

---

## Google sign-in setup

Google sign-in is handled entirely by **Supabase Auth** using the PKCE OAuth
flow. Safekey never sees a Google client secret and never stores Google tokens.

### 1. Create the Google OAuth client

1. Go to **Google Cloud Console → APIs & Services → Credentials**.
2. Configure the OAuth consent screen if prompted.
3. Create credentials → **OAuth client ID** → **Web application**.
4. Add the Supabase callback as an **Authorised redirect URI**:
   ```
   https://PROJECT_REF.supabase.co/auth/v1/callback
   ```
5. Optionally add your app origins as **Authorised JavaScript origins**:
   - `http://localhost:3000`
   - your production origin, e.g. `https://safekey.example.com`
6. Copy the **Client ID** and **Client secret**.

### 2. Enable Google in Supabase

1. In the Supabase dashboard, open **Authentication → Providers → Google**.
2. Enable the provider and paste the Google **Client ID** and **Client secret**.
3. Open **Authentication → URL Configuration** and set:
   - **Site URL**: `http://localhost:3000` in development, your production URL otherwise.
   - **Redirect URLs**: add every app callback, for example
     ```
     http://localhost:3000/auth/callback
     https://safekey.example.com/auth/callback
     ```
     Add `http://localhost:3001/auth/callback` only if you actually use that port.

### 3. Give both apps the Supabase API values

```dotenv
# backend/.env
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=eyJ…

# frontend/.env
NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ…
```

`NEXT_PUBLIC_*` values are inlined into the browser bundle at build time, so
rebuild the web app after changing them. The anon key is public by design; the
API uses it only as the `apikey` header when verifying an access token.

### Flow

1. **Continue with Google** calls `supabase.auth.signInWithOAuth({ provider: "google" })`.
2. Supabase redirects to Google and back to `https://PROJECT_REF.supabase.co/auth/v1/callback`.
3. Supabase then redirects the browser to `/auth/callback`, where the Supabase
   client finishes the PKCE exchange automatically.
4. The browser keeps the Supabase session. Every application request sends
   `Authorization: Bearer <access_token>`.
5. The API verifies the token with `${SUPABASE_URL}/auth/v1/user`, links or
   creates the Safekey user by verified email, and records the Google provider.
6. The callback page redirects to `/dashboard` (or a safe `next` path).

If `SUPABASE_URL`/`SUPABASE_ANON_KEY` are missing on the API, the whole auth
system cannot start. If the browser build lacks `NEXT_PUBLIC_SUPABASE_*`, the
Google button and password forms show a setup notice instead of failing with a
network error.

**Account linking:** a verified Google email links to an existing Safekey account
with the same normalized email. A Google-only account can add a password later
from **Settings → Set a password**. `users.supabase_user_id` stores the external
Supabase identity; it is text because Supabase Auth uses UUIDs internally while
every Safekey table keeps integer keys.

---

## Password recovery (no email)

Password recovery is **email-match-only**. No reset email, link or token is sent.

1. The user enters their email on `/forgot-password`.
2. The browser calls `POST /api/auth/password-reset/check`.
3. The API looks up the Safekey profile. No match returns `404 ACCOUNT_NOT_FOUND`;
   an archived (deleted) profile returns `403 ACCOUNT_ARCHIVED`.
4. When the email matches an active account, the form asks for a new password
   and calls `POST /api/auth/password-reset`.
5. The API sets the password with the Supabase admin API
   (`auth.admin.updateUserById({ password, email_confirm: true })`), records
   `has_password = true`, and returns `204`. The user signs in normally.

The legacy `/reset-password` route now redirects to `/forgot-password`, so old
recovery links still lead somewhere useful.

> **Security trade-off:** knowing the email address is enough to replace that
> account's password. This is intentional for this project, but it is weaker than
> a mailed single-use link. The endpoints are rate limited (10 attempts per
> 15 minutes in production), and the form warns users to continue only on a
> trusted device. Do not expose them on a public deployment without adding a
> second verification factor.

### Rate limits

`POST /api/auth/password-reset/check` and `POST /api/auth/password-reset` share
a 10-request / 15-minute budget per IP in production (effectively unlimited in
development).

---

## Environment variables

### `backend/.env`

| Variable                     | Required | Default                 | Purpose |
| ---------------------------- | :------: | ----------------------- | ------- |
| `NODE_ENV`                   |    no    | `development`           | `development`, `test`, or `production`. Enables stricter rate limits in production. |
| `PORT`                       |    no    | `4000`                  | Express listen port. |
| `ENCRYPTION_KEY`             |   yes    | —                       | Exactly 64 hex characters (32 bytes). AES-256-GCM key for secret fields. |
| `FRONTEND_URL`               |    no    | `http://localhost:3000` | Allowed CORS origin. No trailing slash needed. |
| `SUPABASE_URL`               |   yes    | —                       | Supabase project URL, used for Auth token checks and the data client. |
| `SUPABASE_ANON_KEY`          |   yes    | —                       | Supabase anon/public key, sent as `apikey` when verifying access tokens at `/auth/v1/user`. |
| `SUPABASE_SERVICE_ROLE_KEY`  |   yes    | —                       | Server-only service-role secret used for every Supabase table/RPC data operation. Never expose to the browser. |

The API validates its environment at startup and exits with a readable error if something is missing or malformed.

### `frontend/.env`

| Variable              | Required | Purpose |
| --------------------- | :------: | ------- |
| `BACKEND_URL`         |    no    | Server-side target for the `/api/*` rewrite. Default `http://localhost:4000`. **Baked into the rewrite at build time** for `next build`, so set it before building production. |
| `NEXT_PUBLIC_API_URL` |    no    | Optional direct API base for the browser. Leave empty to use the proxy (recommended). Changing it introduces cross-origin CORS concerns. |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase project URL used by the browser for sign-up, sign-in, Google OAuth and resets. Must match `SUPABASE_URL` on the API. Inlined at build time. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Supabase anon/public key used by the browser. Inlined at build time. |

---

## How Safekey works

### Data model

```
users
  └── folders                 (vaults; status active|archived|failed, unique active name per user)
        ├── folder_columns    (custom fields; unique name per vault)
        └── folder_items      (entries; title, notes, status active|archived)
              └── item_values (one row per entry/column; secret values encrypted)
```

Every primary key is a **32-bit integer identity column**. `users.supabase_user_id`
is the only text identifier, because it is an external Supabase Auth identity
rather than a database key.

All ownership checks are enforced in SQL, not only in the UI. Every table read/write
goes through the `api_*` RPC functions in `backend/db/schema.sql` (scoped by the
integer `user_id`) or a service-role table query that filters on `user_id`.
Row-level security is enabled and only `service_role` holds execute/table
permissions, so the anon key shipped to the browser cannot read vault data.

### Custom columns and multiple accounts

A vault owns its columns, and entries store a value per column. That is what makes "three Instagram accounts in one vault" work: create the vault once with `Username`, `Email`, `Password`, `Recovery email`, and `2FA backup codes`, then add three entries.

Templates only seed the initial columns. Afterwards the vault is fully editable.

### Secret handling

- Secret values are encrypted **before** they are sent to Supabase with AES-256-GCM.
- The AAD context is `v1:{userId}:{itemId}:{columnId}`. Moving ciphertext between users, entries or columns makes decryption fail.
- List and item endpoints return `value: null` for secret columns and only `hasValue: true/false`.
- `GET /api/items/:itemId/reveal/:columnId` returns exactly one value and requires ownership.
- Search covers titles, notes and visible (non-secret) values, both inside a vault and across all vaults. Secret values are never matched or returned.
- Changing a column from plaintext to secret encrypts existing values; changing it back decrypts them, inside a transaction.
- Account credentials are **never stored by Safekey**. Supabase Auth owns password hashing and Google identities.

### Sessions

- The browser holds the Supabase session (`persistSession`, auto-refresh, PKCE).
- Every API call sends `Authorization: Bearer <access_token>`. There is no
  Safekey session cookie.
- The API verifies the token on every request with Supabase's
  `/auth/v1/user` endpoint using the public anon key.
- A verified identity is resolved to the local integer-ID `users` row. The first
  request creates or links that row; later requests refresh `last_login_at` and
  the `has_password` / `has_google` flags.
- The Supabase dashboard can revoke sessions and controls access-token/JWT
  expiry. Safekey itself does not keep a session table.

### Account creation without confirmation

Per the product requirement, registration creates the Supabase Auth user through
the API's service-role admin client with `email_confirm: true`. The browser then
calls `signInWithPassword`, so a session is returned immediately and no
confirmation email is required. This works whether **Confirm email** is on or
off; turning it off is still recommended. See [Security notes](#security-notes)
for the trade-off.

### Google flow

1. The browser starts Supabase's PKCE OAuth flow with `signInWithOAuth({ provider: "google" })`.
2. Supabase redirects through Google and returns the browser to `/auth/callback`.
3. The Supabase client finishes the exchange; the page waits for the session and
   redirects to a safe `next` path or `/dashboard`.
4. The API verifies each later bearer token with `/auth/v1/user`, links the
   Google identity by normalized email when needed, and records `has_google`.
5. The Supabase session stays in the browser; no token is copied into a cookie
   and no Supabase token is stored by the API.

### Reset flow

1. `/forgot-password` calls `POST /api/auth/password-reset/check` with the email.
2. The API requires an active profile for that address (`ACCOUNT_NOT_FOUND` /
   `ACCOUNT_ARCHIVED` otherwise). No email is sent.
3. The form then collects a new password and calls
   `POST /api/auth/password-reset`.
4. The API updates the Supabase identity with the service-role admin client and
   sets `has_password = true` on the local profile.
5. The user signs in with the new password; vaults and entries are unchanged.

---

## API reference

Base URL: `http://localhost:4000` (or `/api` through the Next.js proxy).

All request and response bodies are JSON. Authenticated routes require
`Authorization: Bearer <supabase-access-token>`. The token is verified against
Supabase Auth on every request; there is no cookie-based session.

### Response conventions

Success responses wrap the resource:

```json
{ "user": { "id": 1, "email": "you@example.com" } }
```

Errors use one shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Some of the details need another look.",
    "details": [{ "path": "email", "message": "Enter a valid email address." }]
  }
}
```

Common status codes: `400`, `401`, `403`, `404`, `409`, `422`, `429`, `500`, `503`.

### Public

| Method | Path          | Description |
| ------ | ------------- | ----------- |
| `GET`  | `/api/health` | Database connectivity and uptime. `503` when the DB is down. |
| `GET`  | `/api/config` | `{ appName, googleEnabled }`. |

### Authentication

Sign-in, Google OAuth and the final password update happen through the API.
Registration is proxied through the API so it can create an already-confirmed
Supabase user, and password recovery uses the service-role admin client instead
of an emailed link. The profile endpoints below require a bearer token.

| Method | Path                        | Body | Description |
| ------ | --------------------------- | ---- | ----------- |
| `POST` | `/api/auth/register`        | `{ email, password, fullName? }` | Creates a confirmed Supabase user with `email_confirm: true`; the browser then signs in. Public. `201`. |
| `POST` | `/api/auth/password-reset/check` | `{ email }` | Public. `200 { ok: true }` when an active account uses the email; `404 ACCOUNT_NOT_FOUND` or `403 ACCOUNT_ARCHIVED` otherwise. No email is sent. |
| `POST` | `/api/auth/password-reset`  | `{ email, password }` | Public. Sets a new password for the matched active account via the Supabase admin API. `204`. |
| `GET`  | `/api/auth/me`              | — | Current Safekey user (creates/links the local row on first call). |
| `PATCH`| `/api/auth/me`              | `{ fullName: string \| null }` | Updates the display name. |
| `POST` | `/api/auth/password-set`    | — | Records `has_password = true` after the browser sets a password via Supabase. |
| `DELETE`| `/api/auth/me`             | `{ confirmEmail }` | Archives the profile and reserves its email permanently; the browser should sign out. `204`. |

**User object**

```json
{
  "id": 42,
  "email": "you@example.com",
  "fullName": "Ada Lovelace",
  "hasPassword": true,
  "hasGoogle": false,
  "createdAt": "2026-11-03T10:00:00.000Z"
}
```

**Validation rules**

- Email: normalized, max 254, must look like an email.
- Password: 8–200 characters (also enforced by the Supabase client UI).
- Full name: max 80 characters.
- Setting a password from Settings checks the current password first when the
  account already has one.

### Vaults (folders)

All routes require a bearer token. Vault names are unique per user, case-insensitively.

| Method  | Path                     | Body / query | Description |
| ------- | ------------------------ | ------------ | ----------- |
| `GET`   | `/api/folders`           | — | Vault summaries ordered by `updatedAt` desc, with `itemCount` and `columnNames`. |
| `POST`  | `/api/folders`           | `{ name, description?, color?, icon?, template? }` | Creates a vault and seeds template columns. `201`. |
| `GET`   | `/api/folders/:folderId` | — | Vault with its ordered `columns`. |
| `PATCH` | `/api/folders/:folderId` | `{ name?, description?, color?, icon? }` | Updates supplied fields. |
| `DELETE`| `/api/folders/:folderId` | — | Archives the vault (`status = 'archived'`); its rows stay in Supabase. `204`. |

`color`: `olive | sage | clay | sand | slate | plum` (default `olive`).
`icon`: `folder | key | globe | bank | briefcase | user | cloud | gamepad | mail | lock | code | camera` (default `folder`).
`template`: `blank | login | social | api | banking | identity` (default `blank`).

**Create example**

```bash
curl -X POST http://localhost:3000/api/folders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SAFEKEY_TOKEN" \
  -d '{
    "name": "Instagram",
    "description": "Personal, studio and shop accounts",
    "color": "clay",
    "icon": "camera",
    "template": "social"
  }'
```

**Vault shapes**

```json
{
  "folders": [
    {
      "id": 7,
      "name": "Instagram",
      "description": "Personal, studio and shop accounts",
      "color": "clay",
      "icon": "camera",
      "createdAt": "…",
      "updatedAt": "…",
      "itemCount": 3,
      "columnNames": ["Username", "Email", "Password"]
    }
  ]
}
```

```json
{
  "folder": {
    "id": 7,
    "name": "Instagram",
    "description": null,
    "color": "clay",
    "icon": "camera",
    "createdAt": "…",
    "updatedAt": "…",
    "itemCount": 3,
    "columnNames": ["Username", "Email", "Password"],
    "columns": [
      {
        "id": 19,
        "name": "Password",
        "type": "password",
        "isSecret": true,
        "isRequired": true,
        "position": 2
      }
    ]
  }
}
```

### Columns

| Method  | Path                                  | Body | Description |
| ------- | ------------------------------------- | ---- | ----------- |
| `POST`  | `/api/folders/:folderId/columns`      | `{ name, type?, isSecret?, isRequired? }` | Adds a column. `201`. Max 20 per vault. |
| `PATCH` | `/api/columns/:columnId`              | `{ name?, type?, isSecret?, isRequired? }` | Updates a column and re-encrypts values if secrecy changes. |
| `DELETE`| `/api/columns/:columnId`              | — | Deletes the column and its values. `204`. |
| `PUT`   | `/api/folders/:folderId/columns/order`| `{ ids: number[] }` | Reorders every column; `ids` must contain all column IDs exactly once. |

`type`: `text | password | email | username | url | note | number | date`.

A `password`-typed column is always secret. Column names are unique per vault, case-insensitively, max 40 characters.

### Entries (items)

| Method  | Path                                    | Body / query | Description |
| ------- | --------------------------------------- | ------------ | ----------- |
| `GET`   | `/api/folders/:folderId/items`          | `search?`, `limit?` | Entries in a vault. Search covers title and non-secret values. `limit` 1–500 (default 200). |
| `POST`  | `/api/folders/:folderId/items`          | `{ title, notes?, values? }` | Creates an entry. `201`. |
| `GET`   | `/api/items/:itemId`                    | — | One entry with masked values. |
| `PATCH` | `/api/items/:itemId`                    | `{ title?, notes?, values? }` | Updates supplied fields. `values` is a partial map of column ID → string; `""` clears a value. |
| `DELETE`| `/api/items/:itemId`                    | — | Archives the entry (`status = 'archived'`); it no longer appears in the app. `204`. |
| `GET`   | `/api/items/:itemId/reveal/:columnId`   | — | Returns `{ value }` for exactly one field, decrypting secrets. |
| `GET`   | `/api/search`                           | `q` (min 2 chars), `limit?` | Entries across every active vault. Matches title, notes and visible values; secret values are never searched or returned. `limit` 1–100 (default 20). |

**Entry shape**

```json
{
  "item": {
    "id": 301,
    "title": "Studio account",
    "notes": null,
    "createdAt": "…",
    "updatedAt": "…",
    "folderId": 7,
    "folderName": "Instagram",
    "values": [
      { "columnId": 18, "value": "studio@example.com", "hasValue": true },
      { "columnId": 19, "value": null, "hasValue": true }
    ]
  }
}
```

Secret values always appear as `value: null` in this shape. Use the reveal endpoint to read them.

**Create example**

```bash
curl -X POST "http://localhost:3000/api/folders/$FOLDER_ID/items" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SAFEKEY_TOKEN" \
  -d @- <<JSON
{
  "title": "Studio account",
  "notes": "Recovery codes in the safe",
  "values": {
    "$USERNAME_COLUMN_ID": "studio@example.com",
    "$PASSWORD_COLUMN_ID": "correct horse battery staple"
  }
}
JSON
```

Required columns must have a non-empty trimmed value on create. On update, required validation applies only to columns included in the payload, so partial edits are safe.

---

## Database schema

The full idempotent DDL lives in [`backend/db/schema.sql`](backend/db/schema.sql).

| Table                   | Purpose |
| ----------------------- | ------- |
| `users`                 | Email, profile, Supabase identity (`supabase_user_id`), `has_password`, `has_google`, and `status` (`active` / `archived`). Unique lowercased email and unique non-null Supabase identity. |
| `folders`               | Vault name/description/colour/icon, owner, and `status` (`active` / `archived` / `failed`). Unique active `(user_id, lower(name))`. |
| `folder_columns`        | Name/type/secrecy/required/position. Unique `(folder_id, lower(name))`. Password columns must be secret. |
| `folder_items`          | Entry title and notes plus owner, vault, and `status` (`active` / `archived`). |
| `item_values`           | One value per `(item_id, column_id)`; secret columns hold ciphertext. Cascade on item/column delete. |

Every `id` is `integer generated always as identity primary key` (except
`folder_items.id`, which is `generated by default` so item IDs can be reserved
before their values are encrypted). `updated_at` is maintained by a shared
`touch_updated_at()` trigger on all mutable tables. The foreign keys still use
`ON DELETE CASCADE`, so a hard-deleted user/vault at the database level cleans up
everything beneath it.

Deleting an entry or vault only sets `status = 'archived'` and
`archived_at = now()`. It disappears from lists, reads, updates and reveals, but
the row and its values are retained in the database. A vault starts as
`status = 'failed'` while its template columns are being created and becomes
`active` only when that succeeds; failed/archived vaults are hidden from active
reads.

Deleting an account sets `users.status = 'archived'` and keeps the Supabase Auth
identity, so the email address stays reserved. The deleted account is refused
with `403 ACCOUNT_ARCHIVED`, and registration with the same email is refused
with `409 ACCOUNT_DELETED` — an email used by a deleted account cannot create a
new Safekey account. Vault and entry rows are retained.

---

## Scripts

From the repository root:

| Command               | What it does |
| --------------------- | ------------ |
| `npm run install:all` | Installs backend and frontend dependencies. |
| `npm run dev`         | Runs the API and web app together. |
| `npm run dev:api`     | Runs only Express with `tsx watch`. |
| `npm run dev:web`     | Runs only Next.js dev. |
| `npm run build`       | TypeScript build for the API and production build for Next.js. |
| `npm run typecheck`   | Typechecks both apps without emitting. |
| `npm run keygen`      | Prints a 32-byte random hex secret. |
| `npm run start:api`   | Runs the compiled API (`backend/dist`). |
| `npm run start:web`   | Runs the production Next.js server. |

Backend-only: `npm --prefix backend run dev|build|start|typecheck|keygen`.
Frontend-only: `npm --prefix frontend run dev|build|start|typecheck|lint`.

---

## Production notes

1. **Build both apps**
   ```bash
   # Set these first: Next.js bakes the /api rewrite and NEXT_PUBLIC_* values
   # into the browser/server bundle at build time.
   BACKEND_URL=https://api.internal.example.com \
   NEXT_PUBLIC_SUPABASE_URL=https://PROJECT_REF.supabase.co \
   NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ… \
   npm run build
   ```
   On PowerShell:
   ```powershell
   $env:BACKEND_URL="https://api.internal.example.com"
   $env:NEXT_PUBLIC_SUPABASE_URL="https://PROJECT_REF.supabase.co"
   $env:NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJ…"
   npm run build
   ```
   `FRONTEND_URL` on the API is read at runtime; `BACKEND_URL` and the `NEXT_PUBLIC_*` values are captured during the build. Add the production `/auth/callback` URL to Supabase's **Redirect URLs** and the Google Cloud redirect URI stays the Supabase callback.
2. **Run the API** with `NODE_ENV=production`, a strong `ENCRYPTION_KEY`, `FRONTEND_URL=https://your-domain`, and the `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` for the same project as the web build.
3. **Run Next.js** with `npm run start:web`. It proxies to the `BACKEND_URL` captured during the build, so keep that value stable between build and deploy.
4. **Serve over HTTPS.** Supabase auth needs a secure origin in production, and browsers restrict many auth APIs on plain HTTP origins other than localhost.
5. **Proxy `/api/*`.** Keep the rewrite in `frontend/next.config.ts`. If the web app is on Vercel and the API on Render/Railway/Fly, `BACKEND_URL` is called server-side by Next.js, so no cross-site cookie setup is needed. CORS still allows `FRONTEND_URL`.
6. **Apply schema changes in Supabase.** Run `backend/db/schema.sql` in the Supabase SQL Editor when the schema or `api_*` functions change. There is no direct database migration command.
7. **Reverse proxy:** Express trusts one proxy hop (`trust proxy = 1`) so rate limiting sees the client correctly behind a single load balancer.
8. **Secrets:** never commit `.env`. The repository `.gitignore` excludes `.env`, `.env.local`, build output and dependencies. Keep `SUPABASE_SERVICE_ROLE_KEY` server-only and back up `ENCRYPTION_KEY` separately; losing it loses every secret.

---

## Security notes

### What is protected

- **Credentials:** Supabase Auth owns password hashing and Google OAuth tokens. Safekey never receives or stores a password.
- **API authentication:** every request's bearer token is verified with Supabase's `/auth/v1/user` endpoint before any database query runs.
- **Secrets at rest:** AES-256-GCM, random 96-bit IV per value, auth tag, per-field AAD. Ciphertext is bound to its user, entry and column.
- **Secrets in transit:** never returned by list/item endpoints; revealed one field at a time over HTTPS.
- **Archived accounts:** deleting an account archives the profile and reserves its email. The deleted account is refused, and the same email cannot register again.
- **Input validation:** Zod schemas with length caps, positive 32-bit integer ID parsing, known-column checks, required-field checks, 128 KB JSON body limit.
- **CORS:** browser requests from `FRONTEND_URL` only; the API also allows server-to-server calls with no `Origin`.
- **Rate limits:** 600 requests/15 min globally in production, plus 10 password-reset attempts/15 min. Supabase applies its own limits to sign-in and sign-up.
- **Headers:** Helmet, `x-powered-by` disabled.
- **Ownership:** every folder/column/item query is scoped to the authenticated `user_id`.

### Important limitations

- **This is server-side encryption, not end-to-end encryption.** The API decrypts secrets to show them, so the server (and anyone with both database access and `ENCRYPTION_KEY`) can read them. The UI intentionally does not claim E2E encryption.
- **No email confirmation** on registration, as required. A valid-looking address can be registered without proving ownership. Add verification in Supabase if you open registration publicly.
- **Password reset trusts the email address alone.** The forgot-password flow sends no mail; anyone who knows an active account's email can replace its password. This is a deliberate product choice, mitigated only by rate limiting. Add a second factor (or a mailed link) before a public launch.
- **No 2FA for the Safekey account itself.** Vaults can store 2FA backup codes for other services, but Safekey login is password/Google only.
- **No audit log, sharing, or team roles.** Vaults are single-owner.
- **Key rotation is manual.** Changing `ENCRYPTION_KEY` makes old ciphertext undecryptable (`DECRYPTION_FAILED`). A real rotation needs a re-encryption migration.
- **Session management lives in Supabase.** Revoke sessions from the Supabase dashboard; Safekey does not keep its own session list.
- **Google linking trusts the verified Google email returned by Supabase.** That is standard, but it means control of the Google account implies access to the linked Safekey account.
- **Deletes are soft.** Deleting an entry or vault archives the row; deleting an account archives the `users` row and keeps its Supabase identity. Vault, entry and value rows are retained, and the deleted email cannot be used to register again. There is no user-facing archive browser or restore action yet.

Use HTTPS, keep secrets out of source control, restrict database network access, and take encrypted backups.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| API exits at startup with "Invalid environment configuration" | A required variable is missing or malformed. Compare `backend/.env` with `.env.example`; `ENCRYPTION_KEY` must be 64 hex chars, and `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` are required. |
| API starts but data requests fail or `/api/health` is degraded | `SUPABASE_SERVICE_ROLE_KEY` is wrong, the schema has not been applied, or the project is paused. Run `backend/db/schema.sql` in the Supabase SQL Editor and check the API log. |
| `permission denied for table …` or `permission denied for function api_…` | The schema's grants have not run, or the API is using the anon key for data. Re-run `backend/db/schema.sql`; only `SUPABASE_SERVICE_ROLE_KEY` may access tables/RPCs. |
| `Could not find the function public.api_…` | The SQL schema is out of date. Re-run `backend/db/schema.sql` in Supabase so the `api_*` functions exist. |
| Google button does not appear | `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY` are missing from the browser build. Rebuild the web app after changing `NEXT_PUBLIC_*` values. |
| Google redirects back with `error=redirect_uri_mismatch` | The Google OAuth client must list `https://PROJECT_REF.supabase.co/auth/v1/callback` as an authorised redirect URI. The app's `/auth/callback` belongs in Supabase URL Configuration. |
| Supabase says the redirect URL is not allowed | Add `http://localhost:3000/auth/callback` (and the production equivalent) under **Authentication → URL Configuration → Redirect URLs**. |
| Requests return `401 INVALID_SESSION` | The bearer token is expired, revoked, or from a different Supabase project. Confirm `SUPABASE_URL` on the API matches `NEXT_PUBLIC_SUPABASE_URL` in the browser build, then sign in again. |
| Signed in but every request returns `401` | The API cannot verify the token: missing/wrong anon key, mismatched project, or an unreachable Supabase URL. Check the API log and `GET /api/health`. |
| Sign-up returns no session or "Email not confirmed" | Registration goes through `POST /api/auth/register` and needs `SUPABASE_SERVICE_ROLE_KEY` set on the API. Also ensure **Enable Email Provider** is on. For an account stuck from an earlier `signUp`, register again with the same email: the API confirms unconfirmed users. |
| Password change fails | The current password was wrong. Accounts created only with Google should leave the current-password field empty and use **Set password**. |
| Forgot-password cannot find the email | Recovery only matches an **active** Safekey profile. Check the spelling, use the address on the account, or register if it was never created. Deleted accounts return `ACCOUNT_ARCHIVED` and cannot be recovered. |
| Forgot-password returns `429 RATE_LIMITED` | More than 10 reset attempts came from this IP in 15 minutes. Wait for the window to reset. |
| Password reset says `RESET_UNAVAILABLE` | The profile has no linked Supabase identity. Sign in once with Google/email so the API can link it, or inspect the `users.supabase_user_id` value. |
| `ACCOUNT_DELETED` | Registration refused: this email belongs to a deleted account. Deleted accounts cannot be recreated with the same email — use another address. |
| `ACCOUNT_ARCHIVED` | The profile is archived. Sign-in is refused; the email cannot be reused for a new account. |
| `IDENTITY_CONFLICT` | The email is already linked to a different Supabase identity. Sign in with the original method instead. |
| `DECRYPTION_FAILED` | `ENCRYPTION_KEY` changed or the ciphertext was moved between contexts. Restore the original key. |
| `429 RATE_LIMITED` | Wait for the window to reset. Limits are much higher when `NODE_ENV` is not production. |
| Next.js starts on port 3001 | Another process owns 3000. Update `FRONTEND_URL`, the Supabase redirect URLs, and any OAuth callback URLs to the actual URL. |
| `npm run dev` stops one app and exits | The other app crashed; read its output. Starting the API without a reachable database still runs but `/api/health` reports `degraded`. |

---

## Limitations and next steps

Ideas that fit the current architecture:

- Optional email confirmation and 2FA, both configurable in Supabase Auth.
- Vault sharing with roles and per-user encryption keys.
- Import/export (CSV, Bitwarden JSON) and an encrypted backup format.
- Key rotation with versioned ciphertext keys.
- A UI for Supabase session management and remote sign-out.
- Attachments, TOTP generation, and breach checks.
- Audit events and an optional archive browser/restore action for archived entries.
- Automated integration tests in CI; the current project is verified with typechecking, production builds, and end-to-end API checks.

---

Built as a complete, self-hostable full-stack project. The UI palette is cream `#FAF7EE` and olive `#31372B`; no external UI kit is required.
