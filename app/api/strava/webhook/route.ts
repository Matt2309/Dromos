import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { secureCompare } from "@/lib/secure-compare";
import {
	processWebhookEvent,
	webhookEventSchema,
} from "@/server/services/strava.service";

// ---------------------------------------------------------------------------
// GET — Webhook verification (Strava hub challenge)
// ---------------------------------------------------------------------------

const verificationSchema = z.object({
	"hub.mode": z.literal("subscribe"),
	"hub.challenge": z.string(),
	"hub.verify_token": z.string(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
	const searchParams = Object.fromEntries(request.nextUrl.searchParams);
	const parsed = verificationSchema.safeParse(searchParams);

	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid verification request" },
			{ status: 400 },
		);
	}

	const { "hub.challenge": challenge, "hub.verify_token": verifyToken } =
		parsed.data;

	const expectedToken = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN;
	if (!expectedToken || !secureCompare(verifyToken, expectedToken)) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	return NextResponse.json({ "hub.challenge": challenge });
}

// ---------------------------------------------------------------------------
// POST — Webhook event delivery
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
	const body: unknown = await request.json().catch(() => null);

	// Parse the event — if invalid, still return 200 so Strava doesn't retry
	const parsed = webhookEventSchema.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json({ received: true }, { status: 200 });
	}

	// Strava does not sign webhook payloads, so the only thing tying an event
	// to our subscription is its id. When STRAVA_WEBHOOK_SUBSCRIPTION_ID is
	// not configured the check is skipped (with a warning) rather than
	// silently dropping every event; ownership is enforced downstream anyway
	// (events are re-fetched with the owner's own token and writes are scoped
	// by userId).
	const expectedSubscriptionId = process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID;
	if (expectedSubscriptionId) {
		if (String(parsed.data.subscription_id) !== expectedSubscriptionId) {
			return NextResponse.json({ received: true }, { status: 200 });
		}
	} else {
		console.warn(
			"[Strava Webhook] STRAVA_WEBHOOK_SUBSCRIPTION_ID is not set — subscription_id is not being validated",
		);
	}

	// Await processing so the runtime does not drop the work after response.
	try {
		await processWebhookEvent(parsed.data);
	} catch (err: unknown) {
		console.error("[Strava Webhook] Failed to process event", err);
	}

	return NextResponse.json({ received: true }, { status: 200 });
}
