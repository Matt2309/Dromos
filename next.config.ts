import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Third parties the app really loads: Google Tag Manager (app/layout.tsx),
// which in turn loads GA4 and the Cookiebot consent banner. Anything GTM
// starts loading later has to be added here, or the browser will block it.
const GTM_SCRIPT_SRC = [
	"https://www.googletagmanager.com",
	"https://*.google-analytics.com",
	"https://consent.cookiebot.com",
	"https://consentcdn.cookiebot.com",
];
const GTM_CONNECT_SRC = [
	"https://www.googletagmanager.com",
	"https://*.google-analytics.com",
	"https://*.analytics.google.com",
	"https://consent.cookiebot.com",
	"https://consentcdn.cookiebot.com",
];

// 'unsafe-inline' in script-src is required by the inline consent-mode
// snippet in app/layout.tsx and Next's own inline bootstrap scripts; dropping
// it needs per-request nonces, which would make every page dynamic.
// 'unsafe-eval' is dev-only (React's debugging tooling).
const contentSecurityPolicy = [
	"default-src 'self'",
	`script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"} ${GTM_SCRIPT_SRC.join(" ")}`,
	"style-src 'self' 'unsafe-inline'",
	// Avatars come from Strava's and Google's CDNs (user.image) and GTM/GA
	// fire tracking pixels, so https: images are allowed; images can't run code.
	"img-src 'self' data: blob: https:",
	"font-src 'self'",
	`connect-src 'self' ${GTM_CONNECT_SRC.join(" ")}`,
	"frame-src https://www.googletagmanager.com https://consentcdn.cookiebot.com",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
	{ key: "Content-Security-Policy", value: contentSecurityPolicy },
	{
		key: "Strict-Transport-Security",
		value: "max-age=63072000; includeSubDomains",
	},
	{ key: "X-Content-Type-Options", value: "nosniff" },
	{ key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
	// Legacy twin of CSP frame-ancestors, for browsers that ignore the latter.
	{ key: "X-Frame-Options", value: "DENY" },
	{
		key: "Permissions-Policy",
		value:
			"camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
	},
];

const nextConfig: NextConfig = {
	// Enable standalone output for optimized Docker deployments
	// This generates a .next/standalone directory with only necessary files
	// Reduces image size and improves security by excluding unused dependencies
	output: "standalone",

	// Don't advertise the framework via `X-Powered-By: Next.js`.
	poweredByHeader: false,

	async headers() {
		return [{ source: "/:path*", headers: securityHeaders }];
	},

	async rewrites() {
		return [
			{
				source: "/api/orpc/:path*",
				destination: "/api/orpc",
			},
		];
	},
};

export default nextConfig;
