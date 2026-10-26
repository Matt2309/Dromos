import "server-only";

/**
 * Raw fetch against Resend's API — no `resend` SDK dependency, mirroring the
 * house style already used for Strava (server/infrastructure/strava.client.ts):
 * one third-party HTTP call, one flat file, no SDK. The audit doc (§ 5,
 * docs/gdpr-compliance-audit.md) already records a deliberate decision to
 * reject @upstash/ratelimit for the same reason — avoid adding a dependency
 * (and its supply-chain surface) for something a single `fetch` call covers.
 */

const RESEND_API_URL = "https://api.resend.com/emails";
const SEND_TIMEOUT_MS = 10_000;

export class EmailClientError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "EmailClientError";
	}
}

type SendEmailInput = {
	to: string;
	subject: string;
	html: string;
	text: string;
};

export type SendEmailResult = {
	ok: boolean;
	statusCode: number;
	id?: string;
	error?: string;
};

/**
 * Resolves `EMAIL_FROM` lazily (never at module load) so that `next build` —
 * which imports every server module — doesn't fail in environments/steps
 * that don't have it configured. Same pattern as getEncryptionKey() in
 * lib/encryption.ts.
 */
function getEmailFrom(): string {
	return process.env.EMAIL_FROM ?? "Dromos <onboarding@resend.dev>";
}

/**
 * Sends a transactional email via Resend. Never throws — every failure
 * (missing config, network error, non-2xx response) is folded into
 * `{ ok: false }` so callers (server/services/email.service.ts) can record
 * delivery status in an audit event without their own try/catch, and so a
 * Resend outage can never fail the signup/reset request that triggered it
 * (see `advanced.backgroundTasks.handler` in lib/auth.ts, which already
 * takes the call off the response's critical path).
 *
 * With no `RESEND_API_KEY` configured, emails are not sent — only logged
 * (domain only, never the full address) to stdout. This is what makes local
 * development work without a Resend account.
 */
export async function sendEmail(
	input: SendEmailInput,
): Promise<SendEmailResult> {
	const apiKey = process.env.RESEND_API_KEY;

	if (!apiKey) {
		const domain = input.to.split("@")[1] ?? "unknown";
		console.info(
			`[Email] RESEND_API_KEY not set — logging instead of sending. To: *@${domain}, Subject: "${input.subject}"`,
		);
		return { ok: true, statusCode: 200 };
	}

	try {
		const response = await fetch(RESEND_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				from: getEmailFrom(),
				to: input.to,
				subject: input.subject,
				html: input.html,
				text: input.text,
			}),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});

		if (!response.ok) {
			// Status only: Resend's error body can echo the recipient address,
			// and only the domain is safe to print (data-minimization stance
			// already taken in lib/rate-limit.ts).
			const domain = input.to.split("@")[1] ?? "unknown";
			console.error(
				`[Email] Resend request failed (${response.status}) for *@${domain}`,
			);
			return {
				ok: false,
				statusCode: response.status,
				error: `Resend request failed (${response.status})`,
			};
		}

		const data = (await response.json()) as { id?: string };
		return { ok: true, statusCode: response.status, id: data.id };
	} catch (error) {
		const domain = input.to.split("@")[1] ?? "unknown";
		const message = error instanceof Error ? error.message : "Unknown error";
		console.error(`[Email] Failed to send to *@${domain}:`, message);
		return { ok: false, statusCode: 500, error: message };
	}
}
