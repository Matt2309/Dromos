import { type JsonValue, jsonToToon } from "@jojojoseph/toon-json-converter";
import { z } from "zod";
import { FunctionalType, type Prisma } from "@/lib/generated/prisma/client";
import { stripHealthDataKeys } from "@/lib/health-data";
import { prisma } from "@/lib/prisma";
import {
	type Activity,
	type Athlete,
	activitySchema,
	athleteSchema,
	athleteStatsSchema,
} from "@/lib/types";
import {
	fetchStravaForUser,
	getStravaAthleteId,
	getUserIdByStravaAthleteId,
	StravaClientError,
} from "@/server/infrastructure/strava.client";
import {
	countActivitiesByUserId,
	deleteActivityByStravaId,
	findActivitiesByUserId,
} from "@/server/repositories/activity.repository";
import { upsertGearFunctional } from "@/server/repositories/gear.repository";
import {
	type AthleteTotals,
	applyStatisticsDelta,
	seedStatisticsFromAthleteStats,
	subtractStatistics,
	upsertStatistics,
} from "@/server/repositories/statistics.repository";
import { getHealthDataConsent } from "@/server/repositories/user.repository";

// ---------------------------------------------------------------------------
// Sport-type helpers
// ---------------------------------------------------------------------------

/**
 * Map a Strava sport_type string to the (sportName, terrainType) tuple used
 * in the UserStatistics table.
 */
export function categorizeSportType(sportType: string): {
	sportName: string;
	terrainType: string;
} {
	const mapping: Record<string, { sportName: string; terrainType: string }> = {
		Run: { sportName: "running", terrainType: "road" },
		TrackRun: { sportName: "running", terrainType: "road" },
		TrailRun: { sportName: "running", terrainType: "trail" },
		VirtualRun: { sportName: "running", terrainType: "road" },
		Ride: { sportName: "cycling", terrainType: "road" },
		VirtualRide: { sportName: "cycling", terrainType: "road" },
		MountainBikeRide: { sportName: "cycling", terrainType: "trail" },
		GravelRide: { sportName: "cycling", terrainType: "trail" },
		Swim: { sportName: "swimming", terrainType: "pool" },
		Walk: { sportName: "walking", terrainType: "road" },
		Hike: { sportName: "hiking", terrainType: "trail" },
	};
	return mapping[sportType] ?? { sportName: "other", terrainType: "other" };
}

/**
 * Infer the FunctionalType for gear based on the activity's sport type.
 * Used when creating gear from activity data (webhook flow).
 */
function inferGearTypeFromActivity(sportType: string): FunctionalType {
	const bikeTypes = [
		"Ride",
		"VirtualRide",
		"MountainBikeRide",
		"GravelRide",
		"EBikeRide",
		"Handcycle",
		"Velomobile",
	];

	if (bikeTypes.includes(sportType)) {
		return FunctionalType.BIKE;
	}

	// Default to ROAD_SHOE for running, walking, hiking, and other foot-based activities
	return FunctionalType.ROAD_SHOE;
}

// ---------------------------------------------------------------------------
// DB → UI type transform
// ---------------------------------------------------------------------------

/**
 * Transform a DB Activity row into the UI Activity type (Strava API format).
 */
function dbActivityToUiActivity(
	dbActivity: Awaited<ReturnType<typeof findActivitiesByUserId>>[number],
): Activity {
	return {
		id: Number(dbActivity.stravaId),
		name: dbActivity.name,
		distance: dbActivity.distance,
		moving_time: dbActivity.movingTime,
		elapsed_time: dbActivity.elapsedTime,
		total_elevation_gain: dbActivity.totalElevationGain,
		type: dbActivity.type,
		sport_type: dbActivity.sportType,
		start_date: dbActivity.startDate.toISOString(),
		average_heartrate: dbActivity.averageHeartrate ?? undefined,
		suffer_score: dbActivity.sufferScore ?? undefined,
	};
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

/**
 * Return activities for display in the UI.
 *
 * - If the user already has synced activities, return them from the DB.
 * - If this is the first connection, perform the initial heavy sync:
 *     1. Seed UserStatistics from athlete all-time totals.
 *     2. Fetch and persist the last 30 activities.
 */
export async function getActivitiesForUser(
	userId: string,
): Promise<Activity[]> {
	const count = await countActivitiesByUserId(userId);

	if (count > 0) {
		const dbActivities = await findActivitiesByUserId(userId);
		return dbActivities.map(dbActivityToUiActivity);
	}

	// First-time connection — run the full initial sync
	await runInitialSync(userId);

	const dbActivities = await findActivitiesByUserId(userId);
	return dbActivities.map(dbActivityToUiActivity);
}

/**
 * Get a single activity by Strava ID.
 * Fetch from Strava API with the user's token.
 */
export async function getActivityDetail(
	userId: string,
	stravaActivityId: string,
): Promise<Activity> {
	const result = await fetchStravaForUser<unknown>(
		userId,
		`activities/${stravaActivityId}`,
	);

	if (!result.ok || !result.data) {
		throw new StravaClientError(
			result.error || "Failed to fetch activity",
			result.statusCode,
		);
	}

	const parsed = activitySchema.safeParse(result.data);
	if (!parsed.success) {
		throw new StravaClientError("Invalid activity data from Strava API", 422);
	}

	// Art. 9 GDPR — don't surface health data the user hasn't consented to,
	// even though it was read live from Strava (see gdpr-compliance-audit.md § 3 gap #7).
	const { granted: healthDataAllowed } = await getHealthDataConsent(userId);

	return {
		id: parsed.data.id,
		name: parsed.data.name,
		distance: parsed.data.distance,
		moving_time: parsed.data.moving_time,
		elapsed_time: parsed.data.elapsed_time,
		total_elevation_gain: parsed.data.total_elevation_gain,
		type: parsed.data.type,
		sport_type: parsed.data.sport_type,
		start_date: parsed.data.start_date,
		average_heartrate: healthDataAllowed
			? parsed.data.average_heartrate
			: undefined,
		suffer_score: healthDataAllowed ? parsed.data.suffer_score : undefined,
		gear: parsed.data.gear,
		device_name: parsed.data.device_name,
	};
}

/**
 * Export an activity to TOON JSON format.
 * Fetch the raw activity data from Strava API with the user's token.
 */
export async function getActivityToonExport(
	userId: string,
	stravaActivityId: string,
): Promise<string> {
	const result = await fetchStravaForUser<unknown>(
		userId,
		`activities/${stravaActivityId}`,
	);

	if (!result.ok || !result.data) {
		throw new StravaClientError(
			result.error || "Failed to fetch activity",
			result.statusCode,
		);
	}

	// Art. 9 GDPR — strip health data keys from the raw payload too (this
	// export serves the unparsed Strava response, which carries more health
	// data keys than the parsed `Activity` shape).
	const { granted: healthDataAllowed } = await getHealthDataConsent(userId);
	const data = healthDataAllowed
		? result.data
		: stripHealthDataKeys(result.data as unknown as Record<string, unknown>);

	return jsonToToon(data as JsonValue);
}

/**
 * Perform the initial data fetch for a newly connected Strava user:
 *  1. Seed UserStatistics from athlete all-time totals.
 *  2. Fetch the last 30 activities and persist them.
 */
export async function runInitialSync(userId: string): Promise<void> {
	const athleteId = await getStravaAthleteId(userId);
	if (!athleteId) {
		throw new StravaClientError("Strava account not connected", 401);
	}

	// 1. Seed statistics baseline
	const statsResult = await fetchStravaForUser<unknown>(
		userId,
		`athletes/${athleteId}/stats`,
	);

	if (statsResult.ok && statsResult.data !== undefined) {
		const parsed = athleteStatsSchema.safeParse(statsResult.data);
		if (parsed.success) {
			const { all_run_totals, all_ride_totals } = parsed.data;
			await seedStatisticsFromAthleteStats(
				userId,
				all_run_totals as AthleteTotals,
				all_ride_totals as AthleteTotals,
			);
		}
	}

	// 2. Fetch and persist the last 30 activities
	const activitiesResult = await fetchStravaForUser<unknown[]>(
		userId,
		"athlete/activities?per_page=30",
	);

	if (!activitiesResult.ok || !activitiesResult.data) return;

	const activities = z.array(activitySchema).safeParse(activitiesResult.data);
	if (!activities.success) return;

	// Resolved once for the whole batch — avoids one consent query per activity.
	const { granted: healthDataAllowed } = await getHealthDataConsent(userId);
	for (const activity of activities.data) {
		await persistStravaActivity(userId, activity, healthDataAllowed);
	}

	// 3. Fetch and persist the user equipment
	const athleteResult = await fetchStravaForUser<unknown>(userId, "athlete");
	if (!athleteResult.ok || !athleteResult.data) return;

	const athlete = athleteSchema.safeParse(athleteResult.data);
	if (!athlete.success) return;

	await persistUserEquipment(userId, athlete.data);
}

/**
 * Save a Strava activity object to the DB and update UserStatistics.
 *
 * This function is idempotent:
 * - First insert: applies full statistics delta and increments sessions_count
 * - Subsequent calls (updates): computes delta between old and new values,
 *   applies only the difference, does NOT increment sessions_count
 * - Sport type changes: subtracts from old category, adds to new category
 *
 * Uses a transaction to prevent race conditions between concurrent webhook
 * events or initial sync racing with webhooks.
 *
 * `healthDataAllowed` (Art. 9 GDPR — gdpr-compliance-audit.md § 3 gap #7) must
 * be resolved by the caller: when `false`, health data keys (heart rate,
 * suffer score) are stripped from both the dedicated columns and `rawJson`
 * before persisting.
 */
async function persistStravaActivity(
	userId: string,
	activity: Activity,
	healthDataAllowed: boolean,
): Promise<void> {
	if (!healthDataAllowed) {
		activity = stripHealthDataKeys(activity);
	}

	const stravaId = String(activity.id);
	const { sportName: newSportName, terrainType: newTerrainType } =
		categorizeSportType(activity.sport_type);

	let ownedByAnotherUser = false;

	await prisma.$transaction(async (tx) => {
		// 1. Check if activity already exists
		const existing = await tx.activity.findUnique({
			where: { stravaId },
			select: {
				userId: true,
				distance: true,
				movingTime: true,
				totalElevationGain: true,
				sportType: true,
				startDate: true,
			},
		});

		// Never overwrite (or re-attribute statistics to) a row owned by someone else.
		if (existing && existing.userId !== userId) {
			ownedByAnotherUser = true;
			return;
		}

		// 2. Upsert the activity record
		await tx.activity.upsert({
			where: { stravaId },
			create: {
				stravaId,
				name: activity.name,
				distance: activity.distance,
				movingTime: activity.moving_time,
				elapsedTime: activity.elapsed_time,
				totalElevationGain: activity.total_elevation_gain,
				type: activity.type,
				sportType: activity.sport_type,
				startDate: new Date(activity.start_date),
				averageHeartrate: activity.average_heartrate,
				sufferScore: activity.suffer_score,
				rawJson: activity as unknown as Prisma.InputJsonValue,
				userId,
			},
			update: {
				name: activity.name,
				distance: activity.distance,
				movingTime: activity.moving_time,
				elapsedTime: activity.elapsed_time,
				totalElevationGain: activity.total_elevation_gain,
				type: activity.type,
				sportType: activity.sport_type,
				startDate: new Date(activity.start_date),
				averageHeartrate: activity.average_heartrate,
				sufferScore: activity.suffer_score,
				rawJson: activity as unknown as Prisma.InputJsonValue,
			},
		});

		// 3. Update statistics based on whether this is a new or existing activity
		if (!existing) {
			// New activity: apply full statistics and increment sessions_count
			await upsertStatistics(userId, newSportName, newTerrainType, {
				distanceMeters: activity.distance,
				movingTimeSeconds: activity.moving_time,
				elevationGainMeters: activity.total_elevation_gain,
				startDate: new Date(activity.start_date),
			});
		} else {
			// Existing activity: compute and apply delta
			const { sportName: oldSportName, terrainType: oldTerrainType } =
				categorizeSportType(existing.sportType);

			const sportCategoryChanged =
				oldSportName !== newSportName || oldTerrainType !== newTerrainType;

			if (sportCategoryChanged) {
				// Sport type changed: subtract from old category, add to new category
				// Subtract old values from old category (including decrementing sessions_count)
				await subtractStatistics(userId, oldSportName, oldTerrainType, {
					distanceMeters: existing.distance,
					movingTimeSeconds: existing.movingTime,
					elevationGainMeters: existing.totalElevationGain,
					startDate: existing.startDate,
				});

				// Add new values to new category (including incrementing sessions_count)
				await upsertStatistics(userId, newSportName, newTerrainType, {
					distanceMeters: activity.distance,
					movingTimeSeconds: activity.moving_time,
					elevationGainMeters: activity.total_elevation_gain,
					startDate: new Date(activity.start_date),
				});
			} else {
				// Same sport category: apply only the delta (no sessions_count change)
				const delta = {
					distanceMeters: activity.distance - existing.distance,
					movingTimeSeconds: activity.moving_time - existing.movingTime,
					elevationGainMeters:
						activity.total_elevation_gain - existing.totalElevationGain,
					startDate: new Date(activity.start_date),
				};

				// Only apply delta if there are actual changes
				if (
					delta.distanceMeters !== 0 ||
					delta.movingTimeSeconds !== 0 ||
					delta.elevationGainMeters !== 0
				) {
					await applyStatisticsDelta(
						userId,
						newSportName,
						newTerrainType,
						delta,
						{
							distanceMeters: activity.distance,
							elevationGainMeters: activity.total_elevation_gain,
						},
					);
				}
			}
		}
	});

	if (ownedByAnotherUser) return;

	// Update gear distance if activity has associated gear (outside transaction for simplicity)
	if (activity.gear) {
		await upsertGearFunctional({
			stravaId: activity.gear.id,
			name: activity.gear.name,
			type: inferGearTypeFromActivity(activity.sport_type),
			distance: activity.gear.distance,
			userId,
		});
	}
}

/**
 * Persist user equipment (shoes and bikes) from Strava athlete data.
 */
async function persistUserEquipment(
	userId: string,
	athlete: Athlete,
): Promise<void> {
	// Persist shoes as ROAD_SHOE
	for (const shoe of athlete.shoes) {
		await upsertGearFunctional({
			stravaId: shoe.id,
			name: shoe.name,
			type: FunctionalType.ROAD_SHOE,
			distance: shoe.distance,
			userId,
		});
	}

	// Persist bikes as BIKE
	for (const bike of athlete.bikes) {
		await upsertGearFunctional({
			stravaId: bike.id,
			name: bike.name,
			type: FunctionalType.BIKE,
			distance: bike.distance,
			userId,
		});
	}
}

// ---------------------------------------------------------------------------
// Webhook event processing
// ---------------------------------------------------------------------------

export const webhookEventSchema = z.object({
	aspect_type: z.enum(["create", "update", "delete"]),
	event_time: z.number(),
	object_id: z.number(), // Strava activity ID
	object_type: z.enum(["activity", "athlete"]),
	owner_id: z.number(), // Strava athlete ID
	subscription_id: z.number(),
	updates: z.record(z.string(), z.unknown()).optional(),
});

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/**
 * Process a single Strava webhook event.
 * Returns early (silently) for non-activity events.
 */
export async function processWebhookEvent(event: WebhookEvent): Promise<void> {
	if (event.object_type !== "activity") return;

	const userId = await getUserIdByStravaAthleteId(String(event.owner_id));
	if (!userId) return; // unknown athlete — ignore

	const stravaActivityId = String(event.object_id);

	switch (event.aspect_type) {
		case "create":
			await handleWebhookCreate(userId, stravaActivityId);
			break;
		case "update":
			await handleWebhookUpdate(userId, stravaActivityId);
			break;
		case "delete":
			await handleWebhookDelete(userId, stravaActivityId);
			break;
	}
}

async function handleWebhookCreate(
	userId: string,
	stravaActivityId: string,
): Promise<void> {
	const result = await fetchStravaForUser<unknown>(
		userId,
		`activities/${stravaActivityId}`,
	);

	if (!result.ok || !result.data) return;

	const parsed = activitySchema.safeParse(result.data);
	if (!parsed.success) return;

	// Art. 9 GDPR — webhooks bypass the Garage gate entirely (no UI in the
	// loop), so an undecided user (healthDataConsent === null) must still be
	// treated as not-allowed here (see gdpr-compliance-audit.md § 1.1).
	const { granted: healthDataAllowed } = await getHealthDataConsent(userId);
	await persistStravaActivity(userId, parsed.data, healthDataAllowed);
}

async function handleWebhookUpdate(
	userId: string,
	stravaActivityId: string,
): Promise<void> {
	// Re-fetch the full activity to get any updated fields
	await handleWebhookCreate(userId, stravaActivityId);
}

async function handleWebhookDelete(
	userId: string,
	stravaActivityId: string,
): Promise<void> {
	const deleted = await deleteActivityByStravaId(stravaActivityId, userId);
	if (!deleted) return; // was not in our DB — nothing to subtract

	const { sportName, terrainType } = categorizeSportType(deleted.sportType);

	await subtractStatistics(userId, sportName, terrainType, {
		distanceMeters: deleted.distance,
		movingTimeSeconds: deleted.movingTime,
		elevationGainMeters: deleted.totalElevationGain,
		startDate: deleted.startDate,
	});
}

/**
 * Checks if a user has a valid, non-expired Strava OAuth connection.
 */
export async function isStravaConnected(userId: string): Promise<boolean> {
	const account = await prisma.account.findFirst({
		where: {
			userId,
			providerId: "strava",
		},
		select: {
			accessToken: true,
			accessTokenExpiresAt: true,
		},
	});

	if (!account?.accessToken) {
		return false;
	}

	if (!account.accessTokenExpiresAt) {
		return true;
	}

	return account.accessTokenExpiresAt > new Date();
}

/**
 * Fetch athlete data from Strava and sync user equipment (shoes and bikes).
 * Returns the count of synced items.
 */
export async function syncUserEquipment(
	userId: string,
): Promise<{ shoes: number; bikes: number }> {
	const athleteResult = await fetchStravaForUser<unknown>(userId, "athlete");

	if (!athleteResult.ok || !athleteResult.data) {
		throw new StravaClientError(
			athleteResult.error || "Failed to fetch athlete data",
			athleteResult.statusCode,
		);
	}
	const athlete = athleteSchema.safeParse(athleteResult.data);
	if (!athlete.success) {
		throw new StravaClientError("Invalid athlete data from Strava API", 422);
	}

	await persistUserEquipment(userId, athlete.data);

	return {
		shoes: athlete.data.shoes.length,
		bikes: athlete.data.bikes.length,
	};
}
