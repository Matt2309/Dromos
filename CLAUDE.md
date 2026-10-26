# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm docker:dev          # Start dev environment with Docker (recommended)
pnpm dev                 # Run Next.js dev server directly (requires local Postgres)

# Build
pnpm build
pnpm start

# Linting & formatting (Biome, not ESLint/Prettier)
pnpm biome:lint          # Check linting
pnpm biome:lint:fix      # Fix linting issues
pnpm biome:format:fix    # Auto-format files

# Database (uses dotenv-cli with .env.local)
pnpm db:generate         # Regenerate Prisma client after schema changes
pnpm db:migrate:dev      # Create and apply a new migration
pnpm db:migrate:deploy   # Apply pending migrations (CI/prod)
pnpm db:studio           # Open Prisma Studio
pnpm db:push             # Push schema without migration (prototyping only)

# Staging / production DB variants
pnpm stg-db:studio
pnpm prod-db:studio

# 2FA operator recovery (see Auth § 2FA below)
pnpm db:disable-2fa <email-or-user-id>       # local
pnpm stg-db:disable-2fa <email-or-user-id>   # staging
pnpm prod-db:disable-2fa <email-or-user-id>  # production
```

No test suite is configured at this time.

## Architecture

**Dromos** is a Next.js 16 (App Router) application that syncs Strava activities, tracks athletic statistics, and manages gear ("garage"). The UI language is Italian.

### Layer overview

```
app/                     Next.js App Router — pages and API routes
routers/                 oRPC router definitions (thin: session check → service call)
server/
  infrastructure/        External API clients (Strava OAuth + REST)
  repositories/          All Prisma DB access
  services/              Business logic (strava.service.ts, compliance.service.ts)
lib/                     Shared: auth config, prisma client, query client, types, routes
hooks/                   React hooks (use-strava, use-compliance, use-mobile)
components/              UI components (shadcn/ui based)
prisma/schema.prisma     Single source of truth for the data model
```

### App Router route groups

| Group | Path | Access |
|-------|------|--------|
| `(app)/(auth)` | `/login`, `/register`, `/forgot-password` | PROTECTED (redirect if logged in) |
| `(app)/(auth)` | `/reset-password` | PUBLIC — the token in the URL is the credential, not the session; see Auth § Password reset below |
| `(app)/(auth)` | `/two-factor` | PROTECTED — reached mid sign-in with no session yet (better-auth deletes it before redirecting here), so PROTECTED still lets it through while bouncing an already-signed-in visitor |
| `(app)/(user-app)` | `/`, `/garage`, `/activity/:id`, `/settings/privacy`, `/settings/account` | PRIVATE (redirect if logged out) |
| `(app)/(legal)` | `/privacy-policy` | PUBLIC |

Route access levels (`RouteAccess.PUBLIC/PROTECTED/PRIVATE`) are defined in `lib/routes.ts` and enforced in the user-app layout at `app/(app)/(user-app)/layout.tsx`. That layout also gates rendering behind two sequential checks: privacy policy acceptance (`LegalConsentWall`), then email verification (`EmailVerificationWall` — see Auth § Email verification below).

### API surface

- **`/api/auth/[...all]`** — better-auth handler (email/password, Google OAuth, Strava OAuth via `genericOAuth` plugin)
- **`/api/rpc/[[...rest]]`** — oRPC endpoint. All application data operations go through here. Routers are composed in `routers/index.ts` (`strava.*`, `compliance.*`).
- **`/api/strava/webhook`** — Strava push notifications (create / update / delete activity events). Payloads are unsigned, so every write is scoped to the event owner: delete filters by `{ stravaId, userId }`, `persistStravaActivity` refuses to overwrite a row owned by another user, and `subscription_id` is checked against `STRAVA_WEBHOOK_SUBSCRIPTION_ID` when set (skipped with a warning when unset).
- **`/api/cron/purge-raw-data`** — GDPR retention purge (`GET`, requires `Authorization: Bearer CRON_SECRET`). Runs `purgeStaleActivityData()` and `purgeStaleAuditLogs()`, invoked nightly by the `.github/workflows/purge-raw-data.yml` scheduled workflow.

**Proxy (`proxy.ts`)**: the `config.matcher` must never contain an empty alternative (`a||b`) — it makes the negative lookahead fail on every path and silently disables the proxy (this happened before). `api/auth`, `api/rpc`, `api/cron` and the exact webhook path are excluded by the matcher; the in-function bypasses for webhook/cron compare the pathname with `===`, never `startsWith`.

**Security headers**: `next.config.ts` sets CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and `Permissions-Policy`, and disables `X-Powered-By`. The CSP allowlists only what the app loads (GTM, GA, Cookiebot); anything new that GTM starts loading must be added there. `script-src` keeps `'unsafe-inline'` for the consent-mode snippet in `app/layout.tsx` (nonces would make every page dynamic).

oRPC procedures can be called directly from server components as plain async functions (bypassing HTTP), e.g. `await isStravaConnected({ userId })` in the layout.

**Rate limiting**: `/api/auth/*` is covered by better-auth's built-in rate limiter (configured in `lib/auth.ts` — `rateLimit` + `advanced.ipAddress`), using a bounded in-memory store (`authRateLimitStorage` in `lib/rate-limit.ts`) passed as `rateLimit.customStorage` instead of the default `"memory"` storage — the default has no cap and never evicts a key unless it's read again after expiry. `/api/rpc` sits outside that perimeter, so it has its own bounded limiter (`consumeRateLimit` in `lib/rate-limit.ts`) applied directly in `app/api/rpc/[[...rest]]/route.ts`, not as an oRPC middleware — a middleware would also fire on the server-side `.callable()` invocations above, which have no real client IP/session to key on. `/api/strava/webhook` and `/api/cron/purge-raw-data` are not rate-limited. `rateLimit.customRules` also pins tight limits on every email-sending and 2FA-verification endpoint (`/request-password-reset`, `/send-verification-email`, `/reset-password`, `/verify-email`, `/two-factor/*`) — see Auth § Email verification / § 2FA below. The rate-limit key is always `ip + path`, never per-account.

### Auth

**better-auth is pinned to `~1.6.x`**: 1.7 removes `genericOAuthClient`, which `lib/auth-client.ts`, `LoginForm` and `ConnectStrava` rely on (`authClient.signIn.oauth2` / `authClient.oauth2.link`). Moving to 1.7 means reworking that client flow.

`lib/auth.ts` — server-side better-auth instance. `lib/auth-client.ts` — client-side `createAuthClient` (use the exported `signIn`, `signUp`, `signOut`, `useSession` from there in client components).

Strava uses `genericOAuth` since it isn't a first-class better-auth provider. Account linking is enabled with `allowDifferentEmails: true` so a user can connect their Strava to an existing email account. Consent to the active `PrivacyPolicy`/`TermsConditions` is written only explicitly, via the `compliance` router (`acceptLegalDocuments`) — never stamped automatically on user creation, so an OAuth signup (Google/Strava) still has to go through the `LegalConsentWall` before it can use the app.

`lib/auth.ts` also registers `databaseHooks.user.create.after`, `databaseHooks.session.create.after`, and `databaseHooks.session.delete.before` to record `USER_REGISTERED`/`LOGIN`/`LOGOUT` audit events (see Audit trail below). All three call `recordAuditEventSafe`, so a failing audit write never blocks sign-up, sign-in, or sign-out.

#### Email verification (GDPR audit gap #16)

`emailVerification` in `lib/auth.ts` sends a verification link via Resend on sign-up (`sendOnSignUp: true`, 24h expiry). This is a **soft wall, not `requireEmailVerification: true`**: the session is still created at sign-up (so `RegisterForm` can write the privacy consent it just collected), and the app itself is blocked by `EmailVerificationWall` (`components/auth/email-verification-wall.tsx`, rendered from `app/(app)/(user-app)/layout.tsx` after `LegalConsentWall`) until `emailVerified` is true.

The wall only applies when `server/services/email-verification.service.ts#getEmailVerificationRequirement` returns `required: true` — i.e. `!emailVerified && hasCredentialAccount && isDeliverableEmail(email)`. This three-part predicate exists specifically to avoid ever locking anyone out: Google users arrive with `emailVerified` already true; Strava users never do, but `hasCredentialAccount` excludes every OAuth-only account (no local password to protect, so nothing to verify), and `isDeliverableEmail` (`lib/email-address.ts`) is a backstop that also protects `server/services/email.service.ts#deliverVerificationEmail` from ever handing Strava's synthetic `strava_<id>@strava.local` address to Resend — that guard matters because better-auth's own OAuth `link-account` flow calls `sendVerificationEmail` unconditionally for any new OAuth user with `emailVerified: false`. The wall itself always carries an escape hatch (resend, sign out, and — reusing `DeleteAccountDialog` — delete the account) so a typo'd email at registration can never become a permanent dead end (there is still no profile UI to correct it — Art. 16, still an open gap).

**Do not set `session.cookieCache`** — it isn't configured today, which is exactly what makes `getSession()` re-read `emailVerified` from Postgres on every navigation; turning it on would strand a just-verified user behind the wall for the cache TTL.

#### Password reset

`emailAndPassword.sendResetPassword` (also via Resend) + `/forgot-password` → `/reset-password` implement Art. 32 credential recovery. `revokeSessionsOnPasswordReset: true` kills every existing session on reset (each revocation still fires the `LOGIN`/`LOGOUT` audit hooks above, once per session). `/reset-password` is deliberately `RouteAccess.PUBLIC`, not `PROTECTED` — the token in the URL is the credential, not the session, so a user who is still logged in on the device where they click the emailed link must still reach the form. better-auth's own enumeration protection (identical response body/timing whether or not the address exists) only holds because `advanced.backgroundTasks.handler` in `lib/auth.ts` hands the actual Resend call to `after()` — without it, the "user exists" branch is measurably slower than the "user doesn't exist" branch.

better-auth's own behavior worth knowing: `/reset-password` **creates a `credential` `Account` row for an OAuth-only user** if they don't have one — which is what makes 2FA reachable for a Google/Strava-only user (see below).

#### 2FA (GDPR audit gap #11)

`twoFactor({ issuer: "Dromos" })` in `lib/auth.ts` enables opt-in TOTP + 10 single-use backup codes (`components/settings/two-factor-card.tsx`, `/settings/account`). `TwoFactor.secret`/`backupCodes` are encrypted by better-auth itself with `BETTER_AUTH_SECRET` — **do not** add these columns to `lib/prisma-extensions/account-token-encryption.ts`; that extension only rewrites `args.data`, never `args.where`, and `/two-factor/verify-backup-code` updates with a `where` clause on the ciphertext it just read, so a second encryption layer would break every backup-code redemption. Consequence: **rotating `BETTER_AUTH_SECRET` invalidates every 2FA enrolment**.

On sign-in, `authClient.signIn.email` returns `{ twoFactorRedirect: true }` (a 200, not an error, no session) when the account has 2FA on; `lib/auth-client.ts`'s `twoFactorClient({ onTwoFactorRedirect })` hard-navigates to `/two-factor` (`components/auth/TwoFactorForm.tsx`) because the session cookie was already replaced server-side by a short-lived `two_factor` cookie.

**Known limits** (why gap #11 is ⚠️ PARZIALE, not ✅ RISOLTO in the audit doc):
- The plugin only intercepts `/sign-in/email` — **`/sign-in/social` and `/sign-in/oauth2` are not covered**, so a user with 2FA on who also has Google/Strava linked can bypass it entirely via OAuth sign-in.
- Enable/disable/regenerate-backup-codes all require the account password (`authClient.twoFactor.enable/disable/generateBackupCodes`), so an OAuth-only user has no path to 2FA until they gain a `credential` account (e.g. via `/forgot-password` — see above).

Audit events (`TWO_FACTOR_ENABLED`/`DISABLED`/`BACKUP_CODES_REGENERATED`) are recorded via two mechanisms in `lib/auth.ts`: `databaseHooks.user.update.after` inspects the endpoint `context.path` for the enable/disable flag flip, and a top-level `hooks.after` (`createAuthMiddleware`) catches `/two-factor/generate-backup-codes`, which never touches the `User` row. See Audit trail below.

**Recovery**: the only self-service path is the backup codes. If a user loses both the authenticator and the codes, there is no in-app recovery — an operator runs `pnpm db:disable-2fa <email-or-user-id>` (`scripts/disable-two-factor.ts`) after verifying the user's identity out of band; it clears the `TwoFactor` row, the flag, sessions and `Verification` rows in one transaction and records `TWO_FACTOR_DISABLED` with `metadata: { reason: "operator_recovery" }`.

#### Transactional email

`server/infrastructure/email.client.ts` sends via Resend using raw `fetch` (no SDK — same style as `strava.client.ts`), with `RESEND_API_KEY` read lazily so a missing key never breaks a build; with no key configured, it only logs (domain + subject, never the full address) instead of sending — this is what makes local development work with no Resend account. Templates (`server/infrastructure/email.templates.ts`) are plain inline-HTML functions, not react-email. `lib/email-address.ts#isDeliverableEmail` filters out reserved/synthetic domains (including Strava's `strava.local`) before any send is attempted.

### Database

PostgreSQL via `@prisma/adapter-pg`. Prisma client is generated to `lib/generated/prisma` (non-default path — always run `pnpm db:generate` after schema changes).

Key models: `User`, `Account`, `Session`, `Verification`, `TwoFactor`, `Activity`, `GearFunctional`, `GearDevice`, `UserStatistics`, `PrivacyPolicy`, `AuditLog`.

**`TwoFactor`** (better-auth `twoFactor` plugin, GDPR audit gap #11): `secret`/`backupCodes` are encrypted by better-auth with `BETTER_AUTH_SECRET`, NOT by the `ENCRYPTION_KEY` Prisma extension below — see Auth § 2FA for why adding them there would break backup-code redemption. `onDelete: Cascade` on `userId`. `Verification` also backs the 2FA challenge cookie and the "trust this device" cookie (both keyed by `value = userId`); since `Verification` has no FK to `User`, `server/repositories/user.repository.ts#deleteUserById` explicitly deletes matching rows before deleting the user.

**`UserStatistics.total_time_min`**: field name is misleading — the value is stored in **seconds**, not minutes.

`Activity.rawJson` stores the raw Strava API response and is nullified after 7 days for GDPR compliance (`isPurged` flag).

`GearFunctional` has a self-relation (`parent`/`children`) to link spike pins to their spiked shoe.

### Audit trail

`AuditLog` (GDPR audit gap #10/#12, `docs/gdpr-compliance-audit.md` § 3) is an append-only trail for consent changes, data-subject-rights operations (export/delete), and auth events (login/logout/registration). **It deliberately has no Prisma relation to `User`** — `subjectId` is a plain `String`, not a foreign key — so that `prisma.user.delete()` never has to cascade through it and a deleted user can never resurface via an `include`/`select` anywhere in the codebase. Do not add a relation here without re-reading that gap in the audit doc first.

- `server/repositories/audit-log.repository.ts` — `recordAuditEvent` (accepts an optional `tx` so the write can be atomic with a consent mutation), `pseudonymizeAuditSubject`, `getAuditLogForUser`, `purgeAuditLogsBefore`.
- `server/services/audit.service.ts` — `recordAuditEventSafe`/`pseudonymizeUserAuditTrail` wrap the repository calls in a try/catch that only logs on failure: an audit write must never block the operation it's recording (a login, an export, an account deletion).
- Consent mutations (`server/repositories/legal-consent.repository.ts#recordLegalConsent`, `server/repositories/user.repository.ts#setHealthDataConsent`) write the audit event in the *same* `$transaction` as the consent change — a consent recorded without proof is worse than no consent.
- Account deletion (`compliance.service.ts#deleteUserAccount`) records `ACCOUNT_DELETED` before deleting, then pseudonymizes that user's whole audit trail (SHA-256 hash of the old id) right after — the account is gone, but the fact that it was deleted, and when, remains provable.
- Purged nightly alongside `rawJson` by `/api/cron/purge-raw-data` (`purgeStaleAuditLogs`, 24-month retention — see `AUDIT_LOG_RETENTION_DAYS` in `compliance.service.ts`).
- No IP/user-agent is captured on any audit row, consistent with the data-minimization stance already taken in `lib/rate-limit.ts`.
- `EMAIL_VERIFIED` (from `emailVerification.afterEmailVerification`), `PASSWORD_RESET_REQUESTED`/`PASSWORD_RESET_COMPLETED` (`sendResetPassword`/`onPasswordReset`) — all in `lib/auth.ts`.
- `TWO_FACTOR_ENABLED`/`TWO_FACTOR_DISABLED` — via `databaseHooks.user.update.after(user, context)`, keyed on `context.path` (`/two-factor/verify-totp` / `/two-factor/disable`). This works because `updateWithHooks` passes the calling endpoint's context as the hook's 2nd argument, so `context.path` identifies which plugin route triggered the `User` write. `TWO_FACTOR_BACKUP_CODES_REGENERATED` — via a top-level `hooks.after` (`createAuthMiddleware`) instead, because `/two-factor/generate-backup-codes` only touches the `TwoFactor` row and never reaches `databaseHooks.user.update`. Both live in `lib/auth.ts` — see Auth § 2FA.

### Data flow (Strava sync)

1. **Initial sync** (first time user lands on home): `getActivitiesForUser` detects zero rows → calls `runInitialSync` → seeds `UserStatistics` from athlete all-time totals, fetches last 30 activities, persists each with `persistStravaActivity`, syncs gear.
2. **Ongoing sync**: Strava webhooks hit `/api/strava/webhook` → `processWebhookEvent` → create/update/delete activity in DB + update `UserStatistics` atomically in a Prisma transaction.
3. **Statistics delta**: `persistStravaActivity` is idempotent; updates compute the diff between old and new values so `sessions_count` is never double-counted.

### Strava token handling

`server/infrastructure/strava.client.ts` — `fetchStravaForUser` refreshes the token automatically (with a 5-minute expiry buffer) before making any Strava API call.

`Account.accessToken`/`refreshToken`/`idToken` are encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`) via a Prisma `$extends` query extension (`lib/prisma-extensions/account-token-encryption.ts`) applied to the client exported from `lib/prisma.ts` — encryption/decryption is transparent to every call site, including better-auth's own reads/writes (it uses the same client). Legacy plaintext rows (no `enc:v1:` prefix) are read through unchanged, so this required no downtime migration; `scripts/encrypt-account-tokens.ts` (`pnpm db:encrypt-tokens` / `stg-db:encrypt-tokens` / `prod-db:encrypt-tokens`) is an idempotent backfill for pre-existing rows.

### oRPC + TanStack Query

Client-side queries use `@orpc/tanstack-query`. The query client is configured in `lib/query.ts` (`staleTime: 0`, `gcTime: 5 min`, max 1 retry).

### Environment files

| File | Used for |
|------|----------|
| `.env.local` | Local development |
| `.env.stg.local` | Staging DB scripts |
| `.env.production.local` | Production Docker build and DB scripts |

Required variables: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL`, `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_WEBHOOK_VERIFY_TOKEN`, `STRAVA_WEBHOOK_SUBSCRIPTION_ID` (recommended), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`. See `.env.example`. `RESEND_API_KEY` may be left empty in local dev — see Auth § Transactional email.
