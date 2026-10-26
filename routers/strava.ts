import { ORPCError, os } from "@orpc/server";
import { headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { errorHandlerMiddleware } from "@/routers/middlewares/error-handler";
import { findAllGearByUserId } from "@/server/repositories/gear.repository";
import {
	getActivitiesForUser,
	getActivityDetail,
	getActivityToonExport,
	isStravaConnected as isStravaConnectedServ,
	syncUserEquipment as syncUserEquipmentServ,
} from "@/server/services/strava.service";

/**
 * Helper to extract and validate the current user's ID from the session.
 */
async function getUserIdFromSession(): Promise<string> {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user?.id) {
		throw new ORPCError("UNAUTHORIZED");
	}
	return session.user.id;
}

export const getActivities = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return await getActivitiesForUser(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

// Strava activity ids are numeric. The id is interpolated into a Strava API
// path (`activities/${id}`), so anything else (e.g. `../athlete`) must be
// rejected before it gets there.
const stravaActivityIdSchema = z.string().regex(/^\d{1,20}$/);

export const getActivity = os
	.input(
		z.object({
			id: stravaActivityIdSchema,
		}),
	)
	.handler(async ({ input }) => {
		const userId = await getUserIdFromSession();
		return await getActivityDetail(userId, input.id);
	})
	.use(errorHandlerMiddleware)
	.callable();

export const exportToToon = os
	.input(
		z.object({
			id: stravaActivityIdSchema,
		}),
	)
	.handler(async ({ input }) => {
		const userId = await getUserIdFromSession();
		return await getActivityToonExport(userId, input.id);
	})
	.use(errorHandlerMiddleware)
	.callable();

export const isStravaConnected = os
	.handler(async () => {
        const userId = await getUserIdFromSession();
		return await isStravaConnectedServ(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

export const syncUserEquipment = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return await syncUserEquipmentServ(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

export const getUserEquipment = os
	.handler(async () => {
		const userId = await getUserIdFromSession();
		return await findAllGearByUserId(userId);
	})
	.use(errorHandlerMiddleware)
	.callable();

export const stravaRouter = os.router({
	getActivities,
	getActivity,
	exportToToon,
	isStravaConnected,
	syncUserEquipment,
	getUserEquipment,
});
