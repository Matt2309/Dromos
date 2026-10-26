import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware } from "better-auth/api";
import { genericOAuth, twoFactor } from "better-auth/plugins";
import { after } from "next/server";
import { buildStravaSyntheticEmail } from "@/lib/email-address";
import { prisma } from "@/lib/prisma";
import { authRateLimitStorage } from "@/lib/rate-limit";
import { recordAuditEventSafe } from "@/server/services/audit.service";
import {
	deliverPasswordResetEmail,
	deliverVerificationEmail,
} from "@/server/services/email.service";

const baseURL = process.env.BETTER_AUTH_URL;

export const auth = betterAuth({
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL,
	// Explicit allowlist for the Origin/Referer CSRF check and redirect
	// targets (callbackURL etc.). Same value better-auth derives from baseURL;
	// spelled out so it can't silently widen.
	trustedOrigins: baseURL ? [baseURL] : [],
	session: {
		// Same as better-auth's defaults, pinned so an upstream change can't
		// lengthen session lifetime unnoticed. Do NOT enable `cookieCache`
		// here (see CLAUDE.md § Email verification).
		expiresIn: 60 * 60 * 24 * 7, // 7 days
		updateAge: 60 * 60 * 24, // refresh the expiry once a day
	},
	database: prismaAdapter(prisma, {
		provider: "postgresql",
	}),
	emailAndPassword: {
		enabled: true,
		// Soft wall, not a hard gate: the session IS created at sign-up so
		// RegisterForm can write the privacy consent it just collected. The app
		// itself is gated by EmailVerificationWall in
		// app/(app)/(user-app)/layout.tsx — see
		// server/services/email-verification.service.ts for the predicate.
		requireEmailVerification: false,
		// Art. 32 GDPR — credential-recovery path (GDPR audit gap #11 note:
		// this is also what lets an OAuth-only user gain a password and become
		// eligible for 2FA — see the twoFactor plugin below).
		sendResetPassword: async ({ user, url }) => {
			await deliverPasswordResetEmail(user, url);
		},
		resetPasswordTokenExpiresIn: 60 * 60, // 1h (= default, explicit)
		// A password reset is the remediation for a suspected compromise: every
		// pre-existing session must die with the old password, not just future
		// ones. This fires session.delete.before once per revoked session below.
		revokeSessionsOnPasswordReset: true,
		onPasswordReset: async ({ user }) => {
			await recordAuditEventSafe({
				subjectId: user.id,
				action: "PASSWORD_RESET_COMPLETED",
			});
		},
	},
	// GDPR audit gap #16 (docs/gdpr-compliance-audit.md § 3) / Art. 32 — proof
	// that the address a user registered with is actually theirs. Soft-walled,
	// not hard-blocking: see components/auth/email-verification-wall.tsx for
	// why OAuth-only accounts and Strava's synthetic addresses are excluded
	// from the wall (server/services/email-verification.service.ts).
	emailVerification: {
		// Explicit: `undefined` would fall back to `requireEmailVerification`
		// (false), i.e. nothing would ever be sent.
		sendOnSignUp: true,
		// The wall already has its own "resend" button; re-sending on every
		// sign-in would just be spam.
		sendOnSignIn: false,
		// The user already has a session (autoSignIn on sign-up) — there is
		// nothing to sign in *to*, and leaving this false avoids minting a new
		// session from a replayed link.
		autoSignInAfterVerification: false,
		expiresIn: 60 * 60 * 24, // 24h — the link sits in an inbox, 1h is hostile
		sendVerificationEmail: async ({ user, url }) => {
			await deliverVerificationEmail(user, url);
		},
		afterEmailVerification: async (user) => {
			await recordAuditEventSafe({
				subjectId: user.id,
				action: "EMAIL_VERIFIED",
			});
		},
	},
	socialProviders: {
		google: {
			clientId: process.env.GOOGLE_CLIENT_ID ?? "",
			clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
		},
	},
	account: {
		accountLinking: {
			enabled: true,
			trustedProviders: ["strava"],
			allowDifferentEmails: true,
		},
	},
	advanced: {
		// `Secure` on every auth cookie whenever the app is served over https.
		// HttpOnly + SameSite=Lax are better-auth's defaults, pinned here:
		// `strict` would drop the cookie on the top-level redirect back from
		// Google/Strava and break OAuth sign-in.
		useSecureCookies: baseURL?.startsWith("https://") ?? false,
		defaultCookieAttributes: {
			httpOnly: true,
			sameSite: "lax",
		},
		ipAddress: {
			// Deploy chain: client -> Cloudflare -> reverse proxy -> container.
			// `cf-connecting-ip` is set by Cloudflare and can't be spoofed by the
			// client as long as the origin only accepts traffic from Cloudflare.
			// `x-forwarded-for` is the reverse-proxy fallback; the proxy must
			// OVERWRITE it with the real client IP (not append), otherwise a
			// client can forge it and dodge the rate limit below.
			ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
		},
		// Without this, better-auth's `runInBackgroundOrAwait` AWAITS
		// sendVerificationEmail/sendResetPassword before responding. That makes
		// the "user exists" branch of /request-password-reset measurably slower
		// than the "user doesn't exist" branch — a timing oracle that defeats
		// the constant-response enumeration protection better-auth otherwise
		// builds in — and it puts a third-party API round-trip on the sign-up
		// critical path. `after()` throws outside a request/render scope, so
		// the try/catch matters: `auth` is also imported by build-time and
		// script code paths that have no such scope.
		backgroundTasks: {
			handler: (promise) => {
				try {
					after(promise);
				} catch {
					void promise.catch(() => {});
				}
			},
		},
	},
	// GDPR audit gap #10 (docs/gdpr-compliance-audit.md § 3): audit trail for
	// authentication events. Every hook uses recordAuditEventSafe — an audit
	// log write must never block a login, a signup, or a logout.
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					await recordAuditEventSafe({
						subjectId: user.id,
						action: "USER_REGISTERED",
					});
				},
			},
			// GDPR audit gap #11: 2FA is a security-state change worth recording.
			// The twoFactor plugin has no databaseHooks of its own, but every flip
			// of `twoFactorEnabled` goes through internalAdapter.updateUser, which
			// passes the calling endpoint's context as the 2nd argument — so
			// `context.path` identifies the plugin route that triggered the
			// write. /two-factor/generate-backup-codes only touches the
			// `twoFactor` row (never `user`), so it can't be caught here — see
			// the top-level `hooks.after` below instead.
			update: {
				after: async (user, context) => {
					const path = context?.path;
					if (!path) return;

					// /two-factor/verify-totp only calls updateUser inside
					// `if (!user.twoFactorEnabled)` — i.e. exactly once, on the
					// confirming verification that turns 2FA on. Every later
					// sign-in verification skips the write, so this can't
					// double-record.
					if (path === "/two-factor/verify-totp") {
						await recordAuditEventSafe({
							subjectId: user.id,
							action: "TWO_FACTOR_ENABLED",
							metadata: { method: "totp" },
						});
						return;
					}

					if (path === "/two-factor/disable") {
						await recordAuditEventSafe({
							subjectId: user.id,
							action: "TWO_FACTOR_DISABLED",
						});
					}
				},
			},
		},
		session: {
			create: {
				after: async (session) => {
					await recordAuditEventSafe({
						subjectId: session.userId,
						action: "LOGIN",
					});
				},
			},
			// Fires on every session deletion, including /sign-out, with the full
			// row (still carrying userId) available BEFORE it's removed — unlike
			// the /sign-out endpoint itself, which only has the raw cookie token
			// and doesn't resolve a session middleware, so hooking the endpoint
			// directly wouldn't reliably see who was logging out.
			delete: {
				before: async (session) => {
					await recordAuditEventSafe({
						subjectId: session.userId,
						action: "LOGOUT",
					});
				},
			},
		},
	},
	// Top-level after-hook: a single always-matching middleware (unlike a
	// plugin's `{matcher, handler}[]` hooks), so it MUST early-return for every
	// unrelated path. Needed for /two-factor/generate-backup-codes, which only
	// updates the `twoFactor` row and therefore never reaches
	// databaseHooks.user.update above.
	hooks: {
		after: createAuthMiddleware(async (ctx) => {
			if (ctx.path !== "/two-factor/generate-backup-codes") return;

			// After-hooks also run when the endpoint threw (the APIError becomes
			// the returned response upstream), so check the success shape.
			const returned = ctx.context.returned as { status?: boolean } | undefined;
			if (returned?.status !== true) return;

			const userId = ctx.context.session?.user?.id;
			if (!userId) return;

			await recordAuditEventSafe({
				subjectId: userId,
				action: "TWO_FACTOR_BACKUP_CODES_REGENERATED",
			});
		}),
	},
	// GDPR audit gap #6 (docs/gdpr-compliance-audit.md § 6.1): brute-force
	// protection on auth endpoints (Art. 32 GDPR — appropriate technical
	// measures). Explicit here so it doesn't silently depend on NODE_ENV.
	rateLimit: {
		enabled: true,
		// `customStorage` overrides `storage` entirely — this is a Map-backed
		// store like "memory", but capped (see lib/rate-limit.ts) so a flood of
		// one-off keys can't grow it without bound.
		customStorage: authRateLimitStorage,
		window: 60,
		max: 100,
		customRules: {
			"/sign-in/email": { window: 60, max: 5 },
			"/sign-up/email": { window: 300, max: 5 },
			"/sign-in/social": { window: 60, max: 10 },
			"/sign-in/oauth2": { window: 60, max: 10 },
			// Called on every useSession() — must stay generous or the app
			// self-DoSes on normal navigation.
			"/get-session": { window: 60, max: 300 },
			// Email-sending endpoints: a spam vector and, for the first two, an
			// enumeration vector. better-auth's own defaults already put
			// /request-password-reset and /send-verification-email at 3/60s;
			// pinned explicitly here so an upstream default change can't
			// silently loosen them. /reset-password and /verify-email have NO
			// built-in default and would otherwise inherit the global 100/60s —
			// a generous brute-force budget against a reset token.
			"/request-password-reset": { window: 300, max: 3 },
			"/send-verification-email": { window: 300, max: 3 },
			"/reset-password": { window: 300, max: 5 },
			"/verify-email": { window: 60, max: 20 },
			// The twoFactor plugin ships its own rule (10s / 3 req on
			// /two-factor/*), which resolves to ~1080 attempts/hour against a
			// 6-digit code — customRules is resolved AFTER plugin rules
			// (resolveRateLimitConfig), so these win. Note better-auth's own
			// `otpOptions.allowedAttempts` guard does NOT apply to TOTP; this is
			// the only brute-force control on verify-totp/verify-backup-code.
			"/two-factor/verify-totp": { window: 300, max: 5 },
			"/two-factor/verify-backup-code": { window: 300, max: 5 },
			"/two-factor/enable": { window: 300, max: 5 },
			"/two-factor/disable": { window: 300, max: 5 },
			"/two-factor/generate-backup-codes": { window: 300, max: 5 },
			"/two-factor/get-totp-uri": { window: 300, max: 5 },
		},
	},
	user: {
		additionalFields: {
			// These are only ever written server-side by the compliance router
			// (see routers/compliance.ts, acceptLegalDocuments), after the user
			// explicitly accepts via the register form or the post-login consent wall.
			// `input: false` prevents a client from self-certifying consent through signUp.
			privacyConsentTimestamp: {
				type: "date",
				required: false,
				input: false,
			},
			privacyPolicyId: {
				type: "string",
				required: false,
				input: false,
			},
			termsConsentTimestamp: {
				type: "date",
				required: false,
				input: false,
			},
			termsConditionsId: {
				type: "string",
				required: false,
				input: false,
			},
			// Art. 9 GDPR — health data consent (heart rate, suffer score), only
			// ever written server-side by the compliance router (see
			// routers/compliance.ts, setHealthDataConsent), after the user
			// decides in the Garage gate or the privacy settings page.
			// `input: false` prevents a client from self-certifying this via signUp.
			healthDataConsent: {
				type: "boolean",
				required: false,
				input: false,
			},
			healthDataConsentTimestamp: {
				type: "date",
				required: false,
				input: false,
			},
		},
	},
	plugins: [
		genericOAuth({
			config: [
				{
					providerId: "strava",
					clientId: process.env.STRAVA_CLIENT_ID ?? "",
					clientSecret: process.env.STRAVA_CLIENT_SECRET ?? "",
					authorizationUrl: "https://www.strava.com/oauth/authorize",
					tokenUrl: "https://www.strava.com/oauth/token",
					scopes: ["read,activity:read_all,profile:read_all"],
					authorizationUrlParams: {
						approval_prompt: "auto",
					},
					getUserInfo: async (tokens) => {
						const response = await fetch(
							"https://www.strava.com/api/v3/athlete",
							{
								headers: {
									Authorization: `Bearer ${tokens.accessToken}`,
								},
								signal: AbortSignal.timeout(10_000),
							},
						);

						if (!response.ok) return null;

						const athlete = (await response.json()) as {
							id: number;
							firstname: string;
							lastname: string;
							email?: string;
							profile?: string;
						};

						return {
							id: String(athlete.id),
							name: `${athlete.firstname} ${athlete.lastname}`.trim(),
							email: athlete.email ?? buildStravaSyntheticEmail(athlete.id),
							image: athlete.profile ?? undefined,
							emailVerified: false,
						};
					},
				},
			],
		}),
		// GDPR audit gap #11 (docs/gdpr-compliance-audit.md § 3): opt-in TOTP
		// second factor + single-use backup codes (Art. 32 GDPR). `issuer` is
		// not optional in practice: without it the TOTP URI falls back to
		// `appName`, which defaults to "Better Auth" — that string is what the
		// user sees in their authenticator app. Everything else stays default
		// (6 digits / 30s, 10 backup codes, `storeBackupCodes: "encrypted"`,
		// 10min 2FA cookie, 30d trust-device cookie). `skipVerificationOnEnable`
		// is deliberately left off: the flag must only flip after the user has
		// proved the authenticator actually works, otherwise a
		// mistyped/never-scanned secret locks them out on the next sign-in.
		//
		// Known limitations (see docs/gdpr-compliance-audit.md gap #11 for the
		// full writeup): the plugin only intercepts /sign-in/email — a user who
		// also has Google/Strava linked can bypass 2FA entirely via OAuth
		// sign-in. And enable/disable/regenerate all require the account
		// password, so OAuth-only users (no `credential` Account row) cannot
		// use 2FA until they set a password via /forgot-password.
		twoFactor({
			issuer: "Dromos",
		}),
	],
});
