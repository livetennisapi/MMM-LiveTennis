/* MagicMirror²
 * Node Helper: MMM-LiveTennis
 *
 * All network I/O and all credential handling happen here, on the server.
 * The API key is never sent to the browser and never included in any payload
 * emitted back to the front-end module.
 *
 * By the Live Tennis API team
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");

const MIN_UPDATE_INTERVAL = 30 * 1000;
const REQUEST_TIMEOUT = 15 * 1000;
const SECRET_PLACEHOLDER = /^\*\*SECRET_[^*]+\*\*$/;

module.exports = NodeHelper.create({

	/**
	 * Helper lifecycle start.
	 */
	start () {
		Log.info(`Starting node helper for: ${this.name}`);

		/*
		 * MagicMirror² creates exactly ONE node helper per module type, however
		 * many instances the user puts on the mirror. All per-instance state
		 * therefore lives in this map, keyed by the front-end's `identifier`.
		 */
		this.instances = new Map();
	},

	/**
	 * Helper lifecycle stop. Clear every poll timer so the process can exit.
	 */
	stop () {
		Log.info(`Stopping node helper for: ${this.name}`);
		for (const instanceId of this.instances.keys()) {
			this.clearTimer(instanceId);
		}
		this.instances.clear();
	},

	/**
	 * Receive notifications from the front-end module.
	 * @param {string} notification Notification identifier.
	 * @param {object} payload Notification payload, tagged with `instanceId`.
	 */
	socketNotificationReceived (notification, payload) {
		if (notification !== "LIVETENNIS_CONFIG") return;
		if (!payload || !payload.instanceId) {
			Log.error(`${this.name}: received a config without an instanceId; ignoring.`);
			return;
		}

		const instanceId = payload.instanceId;
		const rawConfig = payload.config || {};

		// A browser reload re-sends the config; drop the previous timer first.
		this.clearTimer(instanceId);

		const instance = {
			instanceId,
			config: this.sanitiseConfig(rawConfig),
			apiKey: this.resolveApiKey(rawConfig),
			timer: null,
			fetching: false
		};
		this.instances.set(instanceId, instance);

		if (!instance.apiKey) {
			Log.error(`${this.name} [${instanceId}]: no API key available. Set the LIVETENNIS_API_KEY environment variable or the module's apiKey option. Get a free key at https://livetennisapi.com/subscribe/free`);
			this.sendSocketNotification("LIVETENNIS_ERROR", { instanceId, kind: "NO_KEY" });
			return;
		}

		this.fetchData(instanceId);
	},

	// ---------------------------------------------------------------------
	// configuration
	// ---------------------------------------------------------------------

	/**
	 * Clamp and copy the incoming config. The credential is deliberately not
	 * copied into this object so it cannot be echoed back by accident.
	 * @param {object} rawConfig Raw module config from the front-end.
	 * @returns {object} Sanitised config without any credential.
	 */
	sanitiseConfig (rawConfig) {
		const raw = rawConfig || {};
		return {
			apiBase: String(raw.apiBase || "https://api.livetennisapi.com/api/public/v1").replace(/\/+$/, ""),
			tour: raw.tour ? String(raw.tour) : "",
			maximumEntries: this.toPositiveInt(raw.maximumEntries, 5),
			upcomingEntries: this.toPositiveInt(raw.upcomingEntries, 3),
			showUpcoming: raw.showUpcoming !== false,
			updateInterval: Math.max(MIN_UPDATE_INTERVAL, this.toPositiveInt(raw.updateInterval, 1800000)),
			retryDelay: Math.max(5000, this.toPositiveInt(raw.retryDelay, 30000))
		};
	},

	/**
	 * Resolve the API key, server side, in order of decreasing safety.
	 *
	 * 1. `LIVETENNIS_API_KEY` in the server environment. The key never appears
	 *    in config.js and therefore never reaches the browser at all.
	 * 2. A `${SECRET_*}` config value with `hideConfigSecrets: true`. The
	 *    browser only ever sees the `**SECRET_***` placeholder; MagicMirror²
	 *    core substitutes the real value in this helper's socket receiver.
	 * 3. A plain `apiKey` string in config.js. Works, but MagicMirror² core
	 *    serves config.js to the browser, so the key is visible client side.
	 * @param {object} rawConfig Raw module config from the front-end.
	 * @returns {string|null} The resolved key, or null when unavailable.
	 */
	resolveApiKey (rawConfig) {
		const fromEnv = process.env.LIVETENNIS_API_KEY;
		if (fromEnv && String(fromEnv).trim()) {
			Log.info(`${this.name}: using API key from LIVETENNIS_API_KEY environment variable.`);
			return String(fromEnv).trim();
		}

		const fromConfig = rawConfig && rawConfig.apiKey ? String(rawConfig.apiKey).trim() : "";
		if (!fromConfig || fromConfig === "__REDACTED__") return null;

		if (SECRET_PLACEHOLDER.test(fromConfig)) {
			// The placeholder was not substituted: hideConfigSecrets is off, or
			// the matching SECRET_* environment variable is not set.
			Log.error(`${this.name}: config secret placeholder "${fromConfig}" was not resolved. Set that environment variable (config.env) and "hideConfigSecrets: true" in config.js.`);
			return null;
		}

		return fromConfig;
	},

	/**
	 * Coerce a value to a positive integer with a fallback.
	 * @param {*} value Candidate value.
	 * @param {number} fallback Value used when the candidate is unusable.
	 * @returns {number} A positive integer.
	 */
	toPositiveInt (value, fallback) {
		const num = Number.parseInt(value, 10);
		return Number.isFinite(num) && num > 0 ? num : fallback;
	},

	// ---------------------------------------------------------------------
	// polling
	// ---------------------------------------------------------------------

	/**
	 * Clear the scheduled poll for one instance.
	 * @param {string} instanceId Front-end module identifier.
	 */
	clearTimer (instanceId) {
		const instance = this.instances.get(instanceId);
		if (instance && instance.timer) {
			clearTimeout(instance.timer);
			instance.timer = null;
		}
	},

	/**
	 * Schedule the next poll for one instance.
	 * @param {string} instanceId Front-end module identifier.
	 * @param {number} delay Delay in milliseconds.
	 */
	scheduleNext (instanceId, delay) {
		this.clearTimer(instanceId);
		const instance = this.instances.get(instanceId);
		if (!instance) return;
		instance.timer = setTimeout(() => this.fetchData(instanceId), delay);
	},

	/**
	 * Fetch live (and optionally upcoming) matches for one instance and push
	 * them to that instance only.
	 * @param {string} instanceId Front-end module identifier.
	 */
	async fetchData (instanceId) {
		const instance = this.instances.get(instanceId);
		if (!instance || !instance.apiKey || instance.fetching) return;
		instance.fetching = true;

		const { config } = instance;

		try {
			const live = await this.request(instance, "/matches", {
				status: "live",
				tour: config.tour,
				limit: config.maximumEntries
			});

			let upcoming = [];
			if (config.showUpcoming) {
				try {
					upcoming = await this.request(instance, "/matches", {
						status: "upcoming",
						tour: config.tour,
						limit: config.upcomingEntries
					});
				} catch (error) {
					// Upcoming is a nice-to-have; never fail the whole poll for it.
					Log.warn(`${this.name} [${instanceId}]: could not fetch upcoming matches: ${error.message}`);
				}
			}

			this.sendSocketNotification("LIVETENNIS_DATA", {
				instanceId,
				matches: this.normaliseMatches(live),
				upcoming: this.normaliseMatches(upcoming),
				fetchedAt: Date.now()
			});

			this.scheduleNext(instanceId, config.updateInterval);
		} catch (error) {
			Log.error(`${this.name} [${instanceId}]: ${error.message}`);
			this.sendSocketNotification("LIVETENNIS_ERROR", {
				instanceId,
				kind: error.kind || "UNKNOWN",
				status: error.status || null
			});
			this.scheduleNext(instanceId, config.retryDelay);
		} finally {
			instance.fetching = false;
		}
	},

	/**
	 * Perform one authenticated GET against the Live Tennis API.
	 * @param {object} instance The per-instance state holding config + apiKey.
	 * @param {string} path Endpoint path, e.g. "/matches".
	 * @param {object} params Query parameters; empty values are dropped.
	 * @returns {Promise<Array>} The list of raw match objects.
	 */
	async request (instance, path, params) {
		const url = new URL(instance.config.apiBase + path);
		for (const [key, value] of Object.entries(params || {})) {
			if (value !== undefined && value !== null && value !== "") {
				url.searchParams.set(key, String(value));
			}
		}

		let response;
		try {
			response = await fetch(url, {
				headers: {
					// The one and only place the credential is used.
					"x-api-key": instance.apiKey,
					accept: "application/json",
					"user-agent": "MMM-LiveTennis (MagicMirror module)"
				},
				signal: AbortSignal.timeout(REQUEST_TIMEOUT)
			});
		} catch (error) {
			throw this.tagError(new Error(`network error calling ${path}: ${error.message}`), "NETWORK");
		}

		if (!response.ok) {
			let kind = "HTTP";
			if (response.status === 401 || response.status === 403) kind = "AUTH";
			else if (response.status === 429) kind = "RATE_LIMIT";

			let detail = "";
			try {
				const body = await response.json();
				if (body && body.error) detail = ` (${body.error})`;
			} catch {
				// non-JSON error body; the status code is enough
			}

			if (kind === "AUTH") {
				Log.error(`${this.name}: the Live Tennis API rejected the API key${detail}. Check LIVETENNIS_API_KEY or the apiKey option; free keys: https://livetennisapi.com/subscribe/free`);
			}

			const error = this.tagError(new Error(`HTTP ${response.status} from ${path}${detail}`), kind);
			error.status = response.status;
			throw error;
		}

		const body = await response.json();
		return this.extractList(body);
	},

	/**
	 * Attach an error classification used by the front-end to pick a message.
	 * @param {Error} error The error to tag.
	 * @param {string} kind One of NETWORK, AUTH, RATE_LIMIT, HTTP.
	 * @returns {Error} The same error, tagged.
	 */
	tagError (error, kind) {
		error.kind = kind;
		return error;
	},

	// ---------------------------------------------------------------------
	// normalisation
	// ---------------------------------------------------------------------

	/**
	 * Pull the array of matches out of a response body, tolerating the common
	 * envelope shapes ({data: []}, {matches: []}, or a bare array).
	 * @param {object|Array} body Parsed response body.
	 * @returns {Array} The list of raw match objects.
	 */
	extractList (body) {
		if (Array.isArray(body)) return body;
		if (!body || typeof body !== "object") return [];
		for (const key of ["data", "matches", "results", "items"]) {
			if (Array.isArray(body[key])) return body[key];
		}
		return [];
	},

	/**
	 * Convert raw API matches into the stable shape the front-end renders.
	 * Defensive by design: a malformed entry is skipped, never thrown on.
	 * @param {Array} list Raw match objects.
	 * @returns {Array} Normalised match objects.
	 */
	normaliseMatches (list) {
		if (!Array.isArray(list)) return [];
		const out = [];

		for (const raw of list) {
			if (!raw || typeof raw !== "object") continue;

			const players = this.normalisePlayers(raw);
			if (players.length === 0) continue;

			out.push({
				id: raw.id ?? raw.match_id ?? null,
				tournament: this.pickString(raw.tournament, raw.tournament_name, raw.event, raw.competition),
				round: this.pickString(raw.round, raw.round_name),
				status: this.pickString(raw.status) || "",
				startTime: raw.start_time ?? raw.startTime ?? raw.scheduled ?? null,
				players
			});
		}

		return out;
	},

	/**
	 * Normalise the two competitors of a match.
	 * @param {object} raw Raw match object.
	 * @returns {Array} Normalised player objects.
	 */
	normalisePlayers (raw) {
		let source = raw.players ?? raw.competitors ?? raw.participants;

		// Some payloads use flat home/away objects instead of a list.
		if (!Array.isArray(source)) {
			const pair = [raw.home ?? raw.player1, raw.away ?? raw.player2].filter(Boolean);
			source = pair.length > 0 ? pair : [];
		}

		return source
			.filter((entry) => entry && typeof entry === "object")
			.map((entry) => ({
				name: this.pickString(entry.name, entry.full_name, entry.player_name, entry.short_name),
				seed: entry.seed ?? null,
				country: this.pickString(entry.country, entry.country_code, entry.nationality),
				serving: Boolean(entry.serving ?? entry.is_serving ?? entry.isServing),
				winner: Boolean(entry.winner ?? entry.is_winner),
				sets: this.normaliseSets(entry),
				points: entry.points ?? entry.point ?? entry.game_score ?? null
			}))
			.filter((player) => player.name);
	},

	/**
	 * Normalise a player's per-set game counts to an array of values.
	 * @param {object} entry Raw player object.
	 * @returns {Array} Per-set scores.
	 */
	normaliseSets (entry) {
		const sets = entry.sets ?? entry.set_scores ?? entry.setScores ?? entry.scores;
		if (Array.isArray(sets)) {
			return sets.map((value) => {
				if (value && typeof value === "object") {
					return value.games ?? value.score ?? value.value ?? "";
				}
				return value;
			});
		}
		return [];
	},

	/**
	 * Return the first argument that is a non-empty string.
	 * @param {...*} values Candidate values.
	 * @returns {string} The first usable string, or "".
	 */
	pickString (...values) {
		for (const value of values) {
			if (typeof value === "string" && value.trim()) return value.trim();
			if (typeof value === "number") return String(value);
		}
		return "";
	}
});
