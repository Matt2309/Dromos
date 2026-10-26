import { ORPCError, os } from "@orpc/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { errorHandlerMiddleware } from "@/routers/middlewares/error-handler";
import { getTwoFactorStatus } from "@/server/services/security.service";

async function getUserIdFromSession(): Promise<string> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user?.id) {
		throw new ORPCError("UNAUTHORIZED");
	}
	return session.user.id;
}

/**
 * 2FA enrolment status for the current user (GDPR audit gap #11), used by
 * app/(app)/(user-app)/settings/account/page.tsx. All mutations (enable,
 * disable, regenerate backup codes) go straight through
 * authClient.twoFactor.* against better-auth's own endpoints — this is the
 * one read this app needs server-side, to decide whether the "Attiva 2FA"
 * action can even be shown for this account.
 */
export const getTwoFactorStatusProcedure = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return getTwoFactorStatus(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

export const securityRouter = os.router({
	getTwoFactorStatus: getTwoFactorStatusProcedure,
});
