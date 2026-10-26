import { ORPCError, os } from "@orpc/server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { errorHandlerMiddleware } from "@/routers/middlewares/error-handler";
import { getUserLegalConsentStatus } from "@/server/repositories/legal-consent.repository";
import {
	checkUserPolicyCompliance,
	getLatestPolicy,
} from "@/server/repositories/policy.repository";
import {
	checkUserTermsCompliance,
	getLatestTerms,
} from "@/server/repositories/terms.repository";
import {
	deleteUserAccount,
	exportUserData,
	getHealthDataConsentStatus,
	recordLegalConsentDecision,
	setHealthDataConsentDecision,
} from "@/server/services/compliance.service";

async function getUserIdFromSession(): Promise<string> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user?.id) {
		throw new ORPCError("UNAUTHORIZED");
	}
	return session.user.id;
}

/**
 * Retrieves the latest active privacy policy from the database.
 */
export const retrieveLatestPolicy = os
	.handler(async () => {
		return await getLatestPolicy();
	})
	.use(errorHandlerMiddleware)
	.callable();

export const isUserAcceptedLastPolicy = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return checkUserPolicyCompliance(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

export const retrieveLatestTerms = os
	.handler(async () => {
		return await getLatestTerms();
	})
	.use(errorHandlerMiddleware)
	.callable();

export const isUserAcceptedLastTerms = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return checkUserTermsCompliance(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

/**
 * Combined status of both legal documents for the current user, used by the
 * user-app layout to decide whether to show the legal consent wall.
 */
export const getLegalConsentStatus = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return getUserLegalConsentStatus(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

/**
 * Records the current user's explicit acceptance of the active privacy
 * policy and/or terms & conditions. The documents to accept are resolved
 * server-side (the client only signals which ones it presented and got
 * checked) so a caller can never certify acceptance of an arbitrary id.
 */
export const acceptLegalDocuments = os
	.input(
		z.object({
			policy: z.boolean().default(false),
			terms: z.boolean().default(false),
		}),
	)
	.handler(async ({ input }) => {
		const userId = await getUserIdFromSession();
		await recordLegalConsentDecision(userId, input);
		revalidatePath("/", "layout");
	})
	.use(errorHandlerMiddleware)
	.callable();

/**
 * Exports all personal data held for the current user as a single JSON
 * envelope (Art. 15 Right of Access / Art. 20 Portability). The user is
 * always resolved from the session — never taken from the client input —
 * so a caller can never request another user's data.
 */
export const exportUserDataProcedure = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return exportUserData(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

/**
 * Permanently deletes the current user's account and all related data
 * (Art. 17 Right to Erasure). Best-effort revokes the Strava authorization
 * first; Prisma cascades remove sessions, activities, gear and statistics.
 */
export const deleteAccount = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return deleteUserAccount(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

/**
 * Current health data consent status (Art. 9 GDPR — heart rate, suffer
 * score) for the current user. Used by the Garage gate and the privacy
 * settings page.
 */
export const getHealthDataConsentStatusProcedure = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return getHealthDataConsentStatus(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

/**
 * Records the current user's explicit decision on health data consent.
 * Refusing or revoking also erases any health data already collected
 * (see server/services/compliance.service.ts).
 */
export const setHealthDataConsentProcedure = os
	.input(z.object({ granted: z.boolean() }))
	.handler(async ({ input }) => {
		const userId = await getUserIdFromSession();
		const result = await setHealthDataConsentDecision(userId, input.granted);
		revalidatePath("/", "layout");
		return result;
	})
	.use(errorHandlerMiddleware)
	.callable();

export const complianceRouter = os.router({
	retrieveLatestPolicy,
	isUserAcceptedLastPolicy,
	retrieveLatestTerms,
	isUserAcceptedLastTerms,
	getLegalConsentStatus,
	acceptLegalDocuments,
	exportUserData: exportUserDataProcedure,
	deleteAccount,
	getHealthDataConsentStatus: getHealthDataConsentStatusProcedure,
	setHealthDataConsent: setHealthDataConsentProcedure,
});
