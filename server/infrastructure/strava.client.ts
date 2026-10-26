import { prisma } from "@/lib/prisma";

const STRAVA_API_BASE = "https://www.strava.com/api/v3";
const STRAVA_REQUEST_TIMEOUT_MS = 10_000;

export class StravaClientError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "StravaClientError";
	}
}

/**
 * Retrieves a valid access token for the given user, refreshing it if expired.
 * Unlike the session-based token getter in services/strava.ts, this function
 * operates purely on userId so it can be called from webhook handlers where
 * there is no active HTTP session.
 */
async function getAccessTokenForUser(userId: string): Promise<string> {
    const account = await prisma.account.findFirst({
        where: { userId, providerId: "strava" },
    });

    if (!account?.accessToken || !account.refreshToken || !account.accessTokenExpiresAt) {
        throw new StravaClientError("Strava account not connected or missing tokens", 401);
    }

    // 1. Aggiungiamo un buffer di 5 minuti (300.000 ms) per evitare scadenze "in volo"
    const bufferTime = 5 * 60 * 1000;
    const isTokenValid = account.accessTokenExpiresAt.getTime() > (Date.now() + bufferTime);

    if (isTokenValid) {
        return account.accessToken;
    }

    // Token expired (o in scadenza) — refresh it
    const refreshBody = new URLSearchParams({
        client_id: process.env.STRAVA_CLIENT_ID ?? "",
        client_secret: process.env.STRAVA_CLIENT_SECRET ?? "",
        grant_type: "refresh_token",
        refresh_token: account.refreshToken,
    });

    const response = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: refreshBody.toString(),
        signal: AbortSignal.timeout(STRAVA_REQUEST_TIMEOUT_MS),
    });

    // 2. Gestione errori migliorata per il debugging
    if (!response.ok) {
        // Status only: the response body is Strava's, not ours to log, and
        // can echo parts of the refresh request.
        console.error(
            `Strava refresh error for user ${userId}: ${response.status}`,
        );

        throw new StravaClientError("Failed to refresh Strava token", 401);
    }

    const data = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
    };

    // 3. Aggiornamento nel database
    await prisma.account.update({
        where: { id: account.id },
        data: {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            accessTokenExpiresAt: new Date(data.expires_at * 1000),
        },
    });

    return data.access_token;
}

export interface StravaFetchResult<T> {
	ok: boolean;
	statusCode: number;
	data?: T;
	error?: string;
}

/**
 * Makes an authenticated request to the Strava API on behalf of a user.
 * Handles token refresh transparently.
 */
export async function fetchStravaForUser<T = unknown>(
	userId: string,
	path: string,
): Promise<StravaFetchResult<T>> {
	try {
		const accessToken = await getAccessTokenForUser(userId);
		const response = await fetch(`${STRAVA_API_BASE}/${path}`, {
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(STRAVA_REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			return {
				ok: false,
				statusCode: response.status,
				error: `Strava API request failed: ${response.statusText}`,
			};
		}

		const data = (await response.json()) as T;

		return { ok: true, statusCode: response.status, data };
	} catch (error) {
		if (error instanceof StravaClientError) {
			return { ok: false, statusCode: error.statusCode, error: error.message };
		}
		// Generic message: it reaches the client through StravaClientError, so
		// network/driver error details must not leak into it.
		console.error(
			`Strava request failed for user ${userId}:`,
			error instanceof Error ? error.name : "unknown",
		);
		return { ok: false, statusCode: 502, error: "Strava request failed" };
	}
}

/**
 * Retrieves the Strava athlete ID (accountId) for a given internal user ID.
 */
export async function getStravaAthleteId(
	userId: string,
): Promise<string | null> {
	const account = await prisma.account.findFirst({
		where: { userId, providerId: "strava" },
		select: { accountId: true },
	});
	return account?.accountId ?? null;
}

/**
 * Looks up the internal userId for a Strava athlete ID.
 */
export async function getUserIdByStravaAthleteId(
	stravaAthleteId: string,
): Promise<string | null> {
	const account = await prisma.account.findFirst({
		where: { accountId: stravaAthleteId, providerId: "strava" },
		select: { userId: true },
	});
	return account?.userId ?? null;
}

/**
 * Revokes Dromos' Strava authorization on the user's behalf (best-effort),
 * called before deleting a user's account (Art. 17 Right to Erasure).
 * Never throws: if there is no connected Strava account or the Strava API
 * call fails, it logs the error and returns false so the caller can proceed
 * with local account deletion regardless.
 */
export async function deauthorizeStrava(userId: string): Promise<boolean> {
	try {
		const accessToken = await getAccessTokenForUser(userId);
		const response = await fetch("https://www.strava.com/oauth/deauthorize", {
			method: "POST",
			headers: { Authorization: `Bearer ${accessToken}` },
			signal: AbortSignal.timeout(STRAVA_REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			console.error(
				`Strava deauthorize failed for user ${userId}: ${response.status} ${response.statusText}`,
			);
			return false;
		}

		return true;
	} catch (error) {
		console.error(
			`Strava deauthorize error for user ${userId}:`,
			error instanceof Error ? error.name : "unknown",
		);
		return false;
	}
}
