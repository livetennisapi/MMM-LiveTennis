/*
 * Local mock of the Live Tennis API.
 *
 * Used by the test suite, and runnable standalone so you can point a real
 * MagicMirror² at it without spending a request from your quota:
 *
 *   node tests/mock-api.js 8099
 *   # then set apiBase: "http://127.0.0.1:8099/s/ok/api/public/v1"
 *
 * It mirrors the real surface:
 *   GET /api/public/v1/matches?status=live|upcoming|completed&tour=&limit=
 * and the real auth contract: `Authorization: Bearer <key>` (preferred) or an
 * `x-api-key` header; a missing/blank credential returns
 *   401 {"error":"unauthorized"}
 *
 * Scenarios are selected by URL prefix so one process drives every case:
 *   /s/ok/...         populated live + upcoming
 *   /s/empty/...      valid response, zero matches
 *   /s/slow/...       never responds (holds the loading state)
 *   /s/badkey/...     always 401 unauthorized
 *   /s/ratelimit/...  always 429 rate_limited
 *   /s/abuse/...      always 429 abuse_throttled + retry_at_epoch (now + 1h)
 *   /s/boom/...       always 500
 *
 * No real credential is present or checked anywhere in this file.
 */

const http = require("node:http");

const LIVE_MATCHES = [
	{
		id: "m-1001",
		tournament: "Wimbledon",
		round: "Final",
		status: "live",
		players: [
			{ name: "J. Sinner", seed: 1, country: "ITA", serving: true, sets: [6, 4, 5], points: "40" },
			{ name: "C. Alcaraz", seed: 2, country: "ESP", serving: false, sets: [4, 6, 4], points: "30" }
		]
	},
	{
		id: "m-1002",
		tournament: "Wimbledon",
		round: "Semi-final",
		status: "live",
		players: [
			{ name: "I. Swiatek", seed: 1, country: "POL", serving: false, sets: [7, 3], points: "15" },
			{ name: "A. Sabalenka", seed: 3, country: "BLR", serving: true, sets: [5, 4], points: "AD" }
		]
	},
	{
		id: "m-1003",
		tournament: "Wimbledon",
		round: "Quarter-final",
		status: "live",
		players: [
			{ name: "N. Djokovic", seed: 4, country: "SRB", serving: true, sets: [6], points: "0" },
			{ name: "A. Zverev", seed: 6, country: "GER", serving: false, sets: [2], points: "0" }
		]
	}
];

const UPCOMING_MATCHES = [
	{
		id: "m-2001",
		tournament: "Wimbledon",
		round: "Semi-final",
		status: "upcoming",
		start_time: "2026-07-26T13:00:00Z",
		players: [
			{ name: "T. Fritz", seed: 5, country: "USA" },
			{ name: "D. Medvedev", seed: 7, country: "RUS" }
		]
	},
	{
		id: "m-2002",
		tournament: "Wimbledon",
		round: "Semi-final",
		status: "upcoming",
		start_time: "2026-07-26T15:30:00Z",
		players: [
			{ name: "C. Gauff", seed: 2, country: "USA" },
			{ name: "E. Rybakina", seed: 4, country: "KAZ" }
		]
	}
];

/**
 * Send a JSON response.
 * @param {object} res Node response object.
 * @param {number} status HTTP status code.
 * @param {object} body Body to serialise.
 */
function json (res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}

/**
 * Create the mock server (not yet listening).
 * @param {object} [options] Options.
 * @param {boolean} [options.quiet] Suppress per-request logging.
 * @returns {import("node:http").Server} The server.
 */
function createMockServer (options = {}) {
	return http.createServer((req, res) => {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const parts = url.pathname.split("/").filter(Boolean);

		// Expect: s/<scenario>/api/public/v1/<endpoint...>
		if (parts[0] !== "s") return json(res, 404, { error: "not_found" });

		const scenario = parts[1];
		const endpoint = `/${parts.slice(5).join("/")}`;
		const authHeader = String(req.headers.authorization || "");
		// "Bearer <key>" (an empty key collapses to bare "Bearer") or a raw key.
		const bearer = (/^Bearer\b/i).test(authHeader) ? authHeader.replace(/^Bearer\s*/i, "") : authHeader;
		const apiKey = req.headers["x-api-key"] || bearer;

		if (!options.quiet) {
			console.log(`[mock] ${req.method} ${url.pathname}${url.search} scenario=${scenario} credential=${apiKey ? "present" : "ABSENT"}`);
		}

		// Real contract: keyless requests are rejected.
		if (!apiKey || !String(apiKey).trim()) return json(res, 401, { error: "unauthorized" });

		if (scenario === "slow") return; // never answers
		if (scenario === "badkey") return json(res, 401, { error: "unauthorized" });
		if (scenario === "ratelimit") return json(res, 429, { error: "rate_limit_exceeded" });
		if (scenario === "abuse") {
			return json(res, 429, {
				error: "abuse_throttled",
				retry_at_epoch: Math.floor(Date.now() / 1000) + 3600
			});
		}
		if (scenario === "boom") return json(res, 500, { error: "internal_server_error" });

		if (endpoint !== "/matches") return json(res, 404, { error: "not_found" });

		const status = url.searchParams.get("status") || "live";
		const limit = Number(url.searchParams.get("limit") || 10);
		const tour = url.searchParams.get("tour") || "";

		if (scenario === "empty") return json(res, 200, { data: [] });

		const list = status === "upcoming" ? UPCOMING_MATCHES : status === "live" ? LIVE_MATCHES : [];
		return json(res, 200, { data: list.slice(0, limit), meta: { status, tour, limit } });
	});
}

/**
 * Start the mock on a port (0 = ephemeral).
 * @param {number} [port] Port to listen on.
 * @param {object} [options] Passed to createMockServer.
 * @returns {Promise<{server: object, port: number, baseUrl: string}>} Handle.
 */
function startMockServer (port = 0, options = {}) {
	const server = createMockServer(options);
	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			const actual = server.address().port;
			resolve({ server, port: actual, baseUrl: `http://127.0.0.1:${actual}` });
		});
	});
}

module.exports = { createMockServer, startMockServer };

if (require.main === module) {
	const port = Number(process.argv[2] || 8099);
	startMockServer(port).then(({ baseUrl }) => {
		console.log(`[mock] Live Tennis API mock listening on ${baseUrl}`);
	});
}
