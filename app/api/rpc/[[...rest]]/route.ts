import { createHash } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import { getSessionCookie } from "better-auth/cookies";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { appRouter } from "@/routers";

const handler = new RPCHandler(appRouter);

const RPC_RATE_LIMIT_MAX = 500;
// Looser than the per-session cap: one IP can legitimately carry several users.
const RPC_RATE_LIMIT_MAX_PER_IP = 1500;
const RPC_RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * GDPR audit gap #6 (docs/gdpr-compliance-audit.md § 6.1): better-auth's
 * rate limiter (see lib/auth.ts) only covers /api/auth. Every personal-data
 * operation (export, delete account, activities) goes through /api/rpc, so
 * it needs its own limiter. This only runs for actual HTTP requests to this
 * route — the .callable() procedures invoked directly from server
 * components (lib/orpc/server.ts) never go through here, so internal
 * rendering never consumes a client's quota.
 */
function sessionBucketKey(request: Request): string | null {
	const cookie = getSessionCookie(request);
	return cookie
		? `sess:${createHash("sha256").update(cookie).digest("hex")}`
		: null;
}

const handleRequest = async (request: Request) => {
	// The session cookie is NOT verified here, so a per-session bucket alone
	// can be dodged by sending a different junk cookie on every request. The
	// per-IP bucket is therefore always charged too; the per-session bucket
	// just keeps users behind a shared IP (Cloudflare/NAT) from starving each
	// other. A key of null means neither exists — no bucket to charge, same
	// trade-off better-auth makes (see get-request-ip.mjs).
	const ip = getClientIp(request);
	const keys = [sessionBucketKey(request), ip ? `ip:${ip}` : null].filter(
		(key): key is string => key !== null,
	);

	for (const key of keys) {
		const { allowed, retryAfter } = consumeRateLimit(
			key,
			key.startsWith("ip:") ? RPC_RATE_LIMIT_MAX_PER_IP : RPC_RATE_LIMIT_MAX,
			RPC_RATE_LIMIT_WINDOW_SECONDS,
		);
		if (!allowed) {
			return new Response(
				JSON.stringify({ message: "Troppe richieste. Riprova più tardi." }),
				{
					status: 429,
					headers: {
						"Content-Type": "application/json",
						"Retry-After": String(retryAfter),
					},
				},
			);
		}
	}

	const { response } = await handler.handle(request, {
		prefix: "/api/rpc",
		context: {},
	});

	return (
		response ??
		new Response("Not found", {
			status: 404,
		})
	);
};

export const HEAD = handleRequest;
export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const PATCH = handleRequest;
export const DELETE = handleRequest;
