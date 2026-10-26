import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/prisma";

export type ActivityCreateInput = {
	stravaId: string;
	name: string;
	distance: number;
	movingTime: number;
	elapsedTime: number;
	totalElevationGain: number;
	type: string;
	sportType: string;
	startDate: Date;
	averageHeartrate?: number | null;
	sufferScore?: number | null;
	rawJson?: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;
	userId: string;
};

/**
 * Upsert an activity by its Strava ID.
 * Creates a new record if it doesn't exist, updates it otherwise.
 */
export async function upsertActivity(input: ActivityCreateInput) {
	return prisma.activity.upsert({
		where: { stravaId: input.stravaId },
		create: {
			stravaId: input.stravaId,
			name: input.name,
			distance: input.distance,
			movingTime: input.movingTime,
			elapsedTime: input.elapsedTime,
			totalElevationGain: input.totalElevationGain,
			type: input.type,
			sportType: input.sportType,
			startDate: input.startDate,
			averageHeartrate: input.averageHeartrate,
			sufferScore: input.sufferScore,
			rawJson: input.rawJson,
			userId: input.userId,
		},
		update: {
			name: input.name,
			distance: input.distance,
			movingTime: input.movingTime,
			elapsedTime: input.elapsedTime,
			totalElevationGain: input.totalElevationGain,
			type: input.type,
			sportType: input.sportType,
			startDate: input.startDate,
			averageHeartrate: input.averageHeartrate,
			sufferScore: input.sufferScore,
			rawJson: input.rawJson,
		},
	});
}

/**
 * Find an activity by its Strava ID.
 */
export async function findActivityByStravaId(stravaId: string) {
	return prisma.activity.findUnique({ where: { stravaId } });
}

/**
 * Delete an activity by its Strava ID, scoped to its owner: the Strava ID
 * alone is not proof of ownership (webhook payloads are unsigned), so an
 * activity belonging to another user is never touched.
 * Returns the deleted record so callers can adjust statistics, or null if not found.
 */
export async function deleteActivityByStravaId(
	stravaId: string,
	userId: string,
) {
	try {
		return await prisma.activity.delete({ where: { stravaId, userId } });
	} catch {
		return null;
	}
}

/**
 * Count activities belonging to a user.
 */
export async function countActivitiesByUserId(userId: string): Promise<number> {
	return prisma.activity.count({ where: { userId } });
}

/**
 * Return all activities for a user, ordered by start date descending.
 */
export async function findActivitiesByUserId(userId: string) {
	return prisma.activity.findMany({
		where: { userId },
		orderBy: { startDate: "desc" },
	});
}

/**
 * Nullify raw GPS / JSON data for every activity synced before `cutoff` that
 * has not yet been purged. Aggregated statistics remain untouched.
 * Idempotent: already-purged rows are excluded by the isPurged filter.
 *
 * @returns The number of activity records that were purged.
 */
export async function purgeActivitiesRawDataBefore(
	cutoff: Date,
): Promise<number> {
	const { count } = await prisma.activity.updateMany({
		where: { createdAt: { lt: cutoff }, isPurged: false },
		data: { rawJson: Prisma.JsonNull, isPurged: true },
	});

	return count;
}

/**
 * Erases health/biometric data (Art. 9 GDPR — average heart rate, suffer
 * score) already collected for a user, both from the dedicated columns and
 * from `rawJson`. Called when the user refuses or revokes health data
 * consent (see docs/gdpr-compliance-audit.md § 3 gap #7).
 *
 * The `jsonb_typeof(...) = 'object'` guard is required: already-purged rows
 * have `rawJson` set to JSON `null`, and Postgres' jsonb `-` operator raises
 * an error when applied to a non-object value.
 *
 * @returns The number of activity records whose columns were nulled out.
 */
export async function eraseHealthDataForUser(userId: string): Promise<number> {
	await prisma.$executeRaw`
		UPDATE activities
		SET "rawJson" = "rawJson" - 'average_heartrate' - 'suffer_score'
		WHERE "userId" = ${userId} AND jsonb_typeof("rawJson") = 'object'
	`;

	const { count } = await prisma.activity.updateMany({
		where: { userId },
		data: { averageHeartrate: null, sufferScore: null },
	});

	return count;
}
