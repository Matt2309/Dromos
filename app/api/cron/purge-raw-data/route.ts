import { type NextRequest, NextResponse } from "next/server";
import { secureCompare } from "@/lib/secure-compare";
import {
	purgeStaleActivityData,
	purgeStaleAuditLogs,
} from "@/server/services/compliance.service";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET — Nightly GDPR retention purge (triggered by a scheduled GitHub Action)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		console.error("[Cron Purge] CRON_SECRET environment variable is not set");
		return NextResponse.json(
			{ error: "Cron secret not configured" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization") ?? "";
	const [scheme, token] = authHeader.split(" ");

	if (scheme !== "Bearer" || !token || !secureCompare(token, cronSecret)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const startedAt = performance.now();

	try {
		const purged = await purgeStaleActivityData();
		const auditLogsPurged = await purgeStaleAuditLogs();

		return NextResponse.json({
			purged,
			auditLogsPurged,
			durationMs: Math.round(performance.now() - startedAt),
			at: new Date().toISOString(),
		});
	} catch (err: unknown) {
		console.error("[Cron Purge] Failed to purge stale activity data", err);
		return NextResponse.json({ error: "Purge failed" }, { status: 500 });
	}
}
