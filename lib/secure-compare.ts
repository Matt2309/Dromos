import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares two secrets in constant time. Both sides are hashed first so the
 * comparison always runs on equal-length buffers and neither the content nor
 * the length of the expected secret leaks through response timing.
 */
export function secureCompare(provided: string, expected: string): boolean {
	const providedDigest = createHash("sha256").update(provided).digest();
	const expectedDigest = createHash("sha256").update(expected).digest();

	return timingSafeEqual(providedDigest, expectedDigest);
}
