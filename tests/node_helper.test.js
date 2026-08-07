/*
 * Unit + integration tests for the MMM-LiveTennis node helper.
 *
 * `node_helper` and `logger` are core MagicMirror² modules that only resolve
 * when the module sits in ~/MagicMirror/modules/. They are aliased here so the
 * helper can be tested directly, the same trick MMM-Formula1 uses via
 * module-alias. Set MM_ROOT if your MagicMirror² lives elsewhere.
 *
 * The mock API is started in-process on an ephemeral port, so the suite is
 * self-contained: `npm test` needs no network and no credential.
 */

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");
const { startMockServer } = require("./mock-api.js");

// Default assumes the standard layout: ~/MagicMirror/modules/MMM-LiveTennis
const MM_ROOT = process.env.MM_ROOT || path.resolve(__dirname, "../../..");

let MOCK = "";
let mockHandle = null;

test.before(async () => {
	mockHandle = await startMockServer(0, { quiet: true });
	MOCK = mockHandle.baseUrl;
});

test.after(() => {
	if (mockHandle) mockHandle.server.close();
});

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
	if (request === "node_helper") return path.join(MM_ROOT, "js", "node_helper.js");
	if (request === "logger") return path.join(MM_ROOT, "js", "logger.js");
	return originalResolve.call(this, request, ...args);
};

const HelperClass = require("../node_helper.js");

/**
 * Build a helper instance with sendSocketNotification captured.
 * @returns {object} `{ helper, sent }` where `sent` collects notifications.
 */
function makeHelper () {
	const helper = new HelperClass();
	helper.setName("MMM-LiveTennis");
	helper.setPath(path.resolve(__dirname, ".."));
	const sent = [];
	helper.sendSocketNotification = (notification, payload) => sent.push({ notification, payload });
	helper.start();
	return { helper, sent };
}

// ---------------------------------------------------------------------------
// config handling
// ---------------------------------------------------------------------------

test("sanitiseConfig strips the trailing slash from apiBase", () => {
	const { helper } = makeHelper();
	const cfg = helper.sanitiseConfig({ apiBase: "https://api.livetennisapi.com/api/public/v1///" });
	assert.strictEqual(cfg.apiBase, "https://api.livetennisapi.com/api/public/v1");
});

test("sanitiseConfig enforces a 30s minimum poll interval", () => {
	const { helper } = makeHelper();
	assert.strictEqual(helper.sanitiseConfig({ updateInterval: 1000 }).updateInterval, 30000);
	assert.strictEqual(helper.sanitiseConfig({ updateInterval: 90000 }).updateInterval, 90000);
});

test("sanitiseConfig lowercases the tour filter to match the API enum", () => {
	const { helper } = makeHelper();
	assert.strictEqual(helper.sanitiseConfig({ tour: "ATP" }).tour, "atp");
	assert.strictEqual(helper.sanitiseConfig({ tour: " Challenger " }).tour, "challenger");
	assert.strictEqual(helper.sanitiseConfig({}).tour, "");
});

test("sanitiseConfig never carries the credential", () => {
	const { helper } = makeHelper();
	const cfg = helper.sanitiseConfig({ apiKey: "super-secret" });
	assert.strictEqual(JSON.stringify(cfg).includes("super-secret"), false);
});

// ---------------------------------------------------------------------------
// credential resolution
// ---------------------------------------------------------------------------

test("resolveApiKey prefers the environment variable over config", () => {
	const { helper } = makeHelper();
	const previous = process.env.LIVETENNIS_API_KEY;
	process.env.LIVETENNIS_API_KEY = "from-env";
	try {
		assert.strictEqual(helper.resolveApiKey({ apiKey: "from-config" }), "from-env");
	} finally {
		if (previous === undefined) delete process.env.LIVETENNIS_API_KEY;
		else process.env.LIVETENNIS_API_KEY = previous;
	}
});

test("resolveApiKey falls back to a plain config key", () => {
	const { helper } = makeHelper();
	const previous = process.env.LIVETENNIS_API_KEY;
	delete process.env.LIVETENNIS_API_KEY;
	try {
		assert.strictEqual(helper.resolveApiKey({ apiKey: "from-config" }), "from-config");
		assert.strictEqual(helper.resolveApiKey({ apiKey: "" }), null);
		// The front-end scrub marker must never be treated as a usable key.
		assert.strictEqual(helper.resolveApiKey({ apiKey: "__REDACTED__" }), null);
		// An unresolved MagicMirror² secret placeholder is not a usable key.
		assert.strictEqual(helper.resolveApiKey({ apiKey: "**SECRET_LIVETENNIS_API_KEY**" }), null);
	} finally {
		if (previous !== undefined) process.env.LIVETENNIS_API_KEY = previous;
	}
});

// ---------------------------------------------------------------------------
// normalisation
// ---------------------------------------------------------------------------

test("normaliseMatches reads the documented players/sets/points shape", () => {
	const { helper } = makeHelper();
	const out = helper.normaliseMatches([{
		id: "m-1",
		tournament: "Wimbledon",
		round: "Final",
		players: [
			{ name: "J. Sinner", seed: 1, serving: true, sets: [6, 4, 5], points: "40" },
			{ name: "C. Alcaraz", seed: 2, serving: false, sets: [4, 6, 4], points: "30" }
		]
	}]);
	assert.strictEqual(out.length, 1);
	assert.strictEqual(out[0].tournament, "Wimbledon");
	assert.strictEqual(out[0].players[0].serving, true);
	assert.deepStrictEqual(out[0].players[0].sets, [6, 4, 5]);
	assert.strictEqual(out[0].players[1].points, "30");
});

test("normaliseMatches accepts home/away and competitors shapes", () => {
	const { helper } = makeHelper();
	const fromHomeAway = helper.normaliseMatches([{
		home: { name: "A. Player", is_serving: true, set_scores: [6] },
		away: { name: "B. Player", set_scores: [3] }
	}]);
	assert.strictEqual(fromHomeAway[0].players.length, 2);
	assert.strictEqual(fromHomeAway[0].players[0].serving, true);

	const fromCompetitors = helper.normaliseMatches([{
		competitors: [{ full_name: "C. Player" }, { full_name: "D. Player" }]
	}]);
	assert.strictEqual(fromCompetitors[0].players[1].name, "D. Player");
});

test("normaliseMatches unwraps object-shaped set scores", () => {
	const { helper } = makeHelper();
	const out = helper.normaliseMatches([{
		players: [
			{ name: "A", sets: [{ games: 6 }, { games: 3 }] },
			{ name: "B", sets: [{ games: 4 }, { games: 6 }] }
		]
	}]);
	assert.deepStrictEqual(out[0].players[0].sets, [6, 3]);
});

test("normaliseMatches drops malformed entries instead of throwing", () => {
	const { helper } = makeHelper();
	assert.deepStrictEqual(helper.normaliseMatches(null), []);
	assert.deepStrictEqual(helper.normaliseMatches([null, 42, "x", {}]), []);
	// A match with no named players is not renderable.
	assert.deepStrictEqual(helper.normaliseMatches([{ players: [{ seed: 1 }] }]), []);
});

test("extractList handles every documented envelope", () => {
	const { helper } = makeHelper();
	assert.deepStrictEqual(helper.extractList([1]), [1]);
	assert.deepStrictEqual(helper.extractList({ data: [2] }), [2]);
	assert.deepStrictEqual(helper.extractList({ matches: [3] }), [3]);
	assert.deepStrictEqual(helper.extractList({ error: "unauthorized" }), []);
});

// ---------------------------------------------------------------------------
// network behaviour (against the in-process mock)
// ---------------------------------------------------------------------------

test("request authenticates with a Bearer Authorization header and the documented query params", async () => {
	const { helper } = makeHelper();
	const instance = {
		apiKey: "mock-test-key-not-real",
		config: { apiBase: `${MOCK}/s/ok/api/public/v1` }
	};
	const list = await helper.request(instance, "/matches", { status: "live", tour: "atp", limit: 2 });
	assert.strictEqual(Array.isArray(list), true);
	assert.strictEqual(list.length, 2);
	assert.strictEqual(list[0].tournament, "Wimbledon");
});

test("a keyless request is rejected by the API with 401 -> kind AUTH", async () => {
	const { helper } = makeHelper();
	const instance = { apiKey: "", config: { apiBase: `${MOCK}/s/ok/api/public/v1` } };
	await assert.rejects(
		() => helper.request(instance, "/matches", {}),
		(error) => {
			assert.strictEqual(error.kind, "AUTH");
			assert.strictEqual(error.status, 401);
			assert.match(error.message, /unauthorized/);
			return true;
		}
	);
});

test("HTTP error codes map to the right error kinds", async () => {
	const { helper } = makeHelper();
	const cases = [
		["badkey", "AUTH", 401],
		["ratelimit", "RATE_LIMIT", 429],
		["boom", "HTTP", 500]
	];
	for (const [scenario, kind, status] of cases) {
		const instance = {
			apiKey: "mock-test-key-not-real",
			config: { apiBase: `${MOCK}/s/${scenario}/api/public/v1` }
		};
		await assert.rejects(
			() => helper.request(instance, "/matches", {}),
			(error) => {
				assert.strictEqual(error.kind, kind, `${scenario} kind`);
				assert.strictEqual(error.status, status, `${scenario} status`);
				return true;
			}
		);
	}
});

test("an abuse_throttled 429 gets its own kind and carries retry_at_epoch", async () => {
	const { helper } = makeHelper();
	const instance = {
		apiKey: "mock-test-key-not-real",
		config: { apiBase: `${MOCK}/s/abuse/api/public/v1` }
	};
	await assert.rejects(
		() => helper.request(instance, "/matches", {}),
		(error) => {
			assert.strictEqual(error.kind, "ABUSE_THROTTLED");
			assert.strictEqual(error.status, 429);
			assert.strictEqual(typeof error.retryAtEpoch, "number");
			assert.ok(error.retryAtEpoch > Date.now() / 1000, "retry_at_epoch is in the future");
			return true;
		}
	);
});

test("abuseBackoffDelay honours retry_at_epoch and clamps to sane bounds", () => {
	const { helper } = makeHelper();
	const now = 1754500000000; // epoch ms
	// epoch seconds one hour ahead -> one hour + the safety buffer
	assert.strictEqual(helper.abuseBackoffDelay(now / 1000 + 3600, now), 3600 * 1000 + 5000);
	// retry instant already in the past -> the minimum, never a hammer loop
	assert.strictEqual(helper.abuseBackoffDelay(now / 1000 - 60, now), 60 * 1000);
	// missing or garbage -> a long default, not a fast retry
	assert.strictEqual(helper.abuseBackoffDelay(undefined, now), 60 * 60 * 1000);
	assert.strictEqual(helper.abuseBackoffDelay("nope", now), 60 * 60 * 1000);
	// epoch milliseconds tolerated
	assert.strictEqual(helper.abuseBackoffDelay(now + 600000, now), 600000 + 5000);
	// never longer than 24 hours
	assert.strictEqual(helper.abuseBackoffDelay(now / 1000 + 999999999, now), 24 * 3600 * 1000);
});

test("an abuse_throttled poll reports ABUSE_THROTTLED and schedules a long pause", async () => {
	const { helper, sent } = makeHelper();
	helper.socketNotificationReceived("LIVETENNIS_CONFIG", {
		instanceId: "module_5_MMM-LiveTennis",
		config: {
			apiKey: "mock-test-key-not-real",
			apiBase: `${MOCK}/s/abuse/api/public/v1`,
			showUpcoming: false,
			retryDelay: 5000
		}
	});

	await new Promise((resolve) => setTimeout(resolve, 1000));

	const err = sent.find((s) => s.notification === "LIVETENNIS_ERROR");
	assert.ok(err, "an error notification was sent");
	assert.strictEqual(err.payload.kind, "ABUSE_THROTTLED");
	assert.strictEqual(err.payload.status, 429);
	// The pause must follow retry_at_epoch (~1 h), not the 5 s retryDelay.
	assert.ok(err.payload.retryAt > Date.now() + 30 * 60 * 1000, "backoff is far in the future");

	const instance = helper.instances.get("module_5_MMM-LiveTennis");
	assert.ok(instance.timer, "a resume poll is scheduled (paused, not dead)");
	helper.stop();
});

test("an unreachable host yields kind NETWORK", async () => {
	const { helper } = makeHelper();
	const instance = { apiKey: "k", config: { apiBase: "http://127.0.0.1:9/api/public/v1" } };
	await assert.rejects(
		() => helper.request(instance, "/matches", {}),
		(error) => {
			assert.strictEqual(error.kind, "NETWORK");
			return true;
		}
	);
});

// ---------------------------------------------------------------------------
// multi-instance behaviour
// ---------------------------------------------------------------------------

test("each instance is polled and answered independently", async () => {
	const { helper, sent } = makeHelper();

	helper.socketNotificationReceived("LIVETENNIS_CONFIG", {
		instanceId: "module_0_MMM-LiveTennis",
		config: { apiKey: "mock-test-key-not-real", apiBase: `${MOCK}/s/ok/api/public/v1`, showUpcoming: false }
	});
	helper.socketNotificationReceived("LIVETENNIS_CONFIG", {
		instanceId: "module_1_MMM-LiveTennis",
		config: { apiKey: "mock-test-key-not-real", apiBase: `${MOCK}/s/empty/api/public/v1`, showUpcoming: false }
	});

	await new Promise((resolve) => setTimeout(resolve, 1500));

	const zero = sent.find((s) => s.payload.instanceId === "module_0_MMM-LiveTennis");
	const one = sent.find((s) => s.payload.instanceId === "module_1_MMM-LiveTennis");

	assert.ok(zero, "instance 0 got a reply");
	assert.ok(one, "instance 1 got a reply");
	assert.strictEqual(zero.notification, "LIVETENNIS_DATA");
	assert.strictEqual(zero.payload.matches.length > 0, true);
	assert.strictEqual(one.notification, "LIVETENNIS_DATA");
	assert.strictEqual(one.payload.matches.length, 0);

	// Two different helpers must not share state.
	assert.strictEqual(helper.instances.size, 2);
	helper.stop();
});

test("a missing key reports NO_KEY to that instance only", () => {
	const { helper, sent } = makeHelper();
	const previous = process.env.LIVETENNIS_API_KEY;
	delete process.env.LIVETENNIS_API_KEY;
	try {
		helper.socketNotificationReceived("LIVETENNIS_CONFIG", {
			instanceId: "module_9_MMM-LiveTennis",
			config: { apiKey: "", apiBase: `${MOCK}/s/ok/api/public/v1` }
		});
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].notification, "LIVETENNIS_ERROR");
		assert.strictEqual(sent[0].payload.kind, "NO_KEY");
		assert.strictEqual(sent[0].payload.instanceId, "module_9_MMM-LiveTennis");
	} finally {
		if (previous !== undefined) process.env.LIVETENNIS_API_KEY = previous;
	}
});

test("no payload sent to the front-end ever contains the credential", async () => {
	const { helper, sent } = makeHelper();
	helper.socketNotificationReceived("LIVETENNIS_CONFIG", {
		instanceId: "module_0_MMM-LiveTennis",
		config: { apiKey: "leak-canary-value", apiBase: `${MOCK}/s/ok/api/public/v1` }
	});
	await new Promise((resolve) => setTimeout(resolve, 1500));
	assert.ok(sent.length > 0, "something was sent");
	assert.strictEqual(JSON.stringify(sent).includes("leak-canary-value"), false);
	helper.stop();
});
