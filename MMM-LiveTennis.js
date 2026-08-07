/* MagicMirror²
 * Module: MMM-LiveTennis
 *
 * Live tennis scores — ATP, WTA, Challenger, ITF and juniors — powered by
 * the Live Tennis API (https://livetennisapi.com).
 *
 * By the Live Tennis API team
 * MIT Licensed.
 *
 * SECURITY NOTE
 * -------------
 * This front-end file never performs an HTTP request and never renders the
 * API key. The key is resolved and used exclusively inside `node_helper.js`
 * (server side). See the "Keeping your API key out of the browser" section of
 * the README for the three supported ways to supply the key.
 */

Module.register("MMM-LiveTennis", {

	// Minimum MagicMirror² core version. 2.30.0 is the oldest release that has
	// the module lifecycle + logger API this module relies on.
	requiresVersion: "2.30.0",

	defaults: {
		// --- Credentials -------------------------------------------------
		// Preferred: leave empty and export LIVETENNIS_API_KEY on the server.
		// Also accepts "${SECRET_LIVETENNIS_API_KEY}" together with
		// `hideConfigSecrets: true`. A plain string works too but is visible
		// to the browser (MagicMirror² core serves config.js to the client).
		apiKey: "",

		// --- Endpoint ----------------------------------------------------
		apiBase: "https://api.livetennisapi.com/api/public/v1",

		// --- What to show ------------------------------------------------
		tour: "", // "" = all tours, or "atp" / "wta" / "challenger" / "itf" / "juniors" (any case)
		maximumEntries: 5, // max live matches rendered
		showUpcoming: true, // append upcoming matches when < maximumEntries live
		upcomingEntries: 3, // max upcoming matches rendered
		showTournament: true, // show tournament / round caption per match
		showSets: true, // show completed + current set scores
		showGamePoints: true, // show the current game score (0/15/30/40/AD)
		showServingIndicator: true,
		showFooter: true, // "Updated hh:mm" footer line
		hideWhenEmpty: false, // hide the whole module when nothing to show

		// --- Timing ------------------------------------------------------
		updateInterval: 30 * 60 * 1000, // poll cadence, ms (min enforced: 30s). 30 min keeps the default config (2 req/poll with showUpcoming) at 96 req/day, inside the free tier's 100/day; faster polling needs the Basic tier.
		retryDelay: 30 * 1000, // backoff after a failed poll, ms
		animationSpeed: 1000, // updateDom animation, ms

		// --- Misc --------------------------------------------------------
		tableClass: "small"
	},

	/**
	 * Stylesheets required by this module.
	 * @returns {string[]} List of css files.
	 */
	getStyles () {
		return ["font-awesome.css", "MMM-LiveTennis.css"];
	},

	/**
	 * Translation files shipped with this module.
	 * @returns {object} Map of language code to translation file.
	 */
	getTranslations () {
		return {
			en: "translations/en.json",
			de: "translations/de.json",
			es: "translations/es.json",
			fr: "translations/fr.json",
			nl: "translations/nl.json"
		};
	},

	/**
	 * Module lifecycle start. Hands the config to the node helper and then
	 * scrubs the credential from this module's own client-side state.
	 */
	start () {
		Log.info(`Starting module: ${this.name}`);

		this.loaded = false;
		this.error = null;
		this.matches = [];
		this.upcoming = [];
		this.lastUpdated = null;
		this.failureCount = 0;

		/*
		 * Hand the whole config to the helper exactly once, tagged with this
		 * instance's identifier. MagicMirror² creates ONE node helper per module
		 * type and `sendSocketNotification` broadcasts to every instance of that
		 * type, so both directions must be addressed explicitly or a second
		 * MMM-LiveTennis on the mirror would overwrite the first.
		 *
		 * When `hideConfigSecrets: true` is used, MagicMirror² core restores the
		 * real `**SECRET_***` value inside the helper's socket receiver, so the
		 * real key never travels over this socket either.
		 */
		/*
		 * Send a DETACHED copy. socket.io serialises the payload asynchronously,
		 * so handing over `this.config` by reference and then scrubbing it below
		 * would race: the scrub wins and the helper receives "__REDACTED__".
		 */
		this.sendSocketNotification("LIVETENNIS_CONFIG", {
			instanceId: this.identifier,
			config: { ...this.config }
		});

		/*
		 * Drop the credential from this module instance's config. `this.config`
		 * is a private shallow copy (js/module.js -> setConfig uses
		 * Object.assign({}, defaults, config)), so this cannot corrupt the
		 * core config object, but it does guarantee that anything that later
		 * dumps this module's config -- MM.getModules(), a debug overlay, a
		 * crash report -- cannot leak the key.
		 */
		if (this.config.apiKey) {
			this.config.apiKey = "__REDACTED__";
		}
	},

	/**
	 * Handle notifications coming back from the node helper.
	 * @param {string} notification Notification identifier.
	 * @param {object} payload Notification payload.
	 */
	socketNotificationReceived (notification, payload) {
		// The helper broadcasts to every instance; only act on our own messages.
		if (!payload || payload.instanceId !== this.identifier) return;

		switch (notification) {
			case "LIVETENNIS_DATA":
				this.matches = Array.isArray(payload.matches) ? payload.matches : [];
				this.upcoming = Array.isArray(payload.upcoming) ? payload.upcoming : [];
				this.lastUpdated = payload.fetchedAt || Date.now();
				this.error = null;
				this.failureCount = 0;
				this.loaded = true;
				this.updateDom(this.config.animationSpeed);
				break;

			case "LIVETENNIS_ERROR":
				/*
				 * Keep the last good scoreboard on screen and only count the
				 * failure. A blank module is worse than a slightly stale one.
				 */
				this.failureCount += 1;
				this.error = {
					kind: payload && payload.kind ? payload.kind : "UNKNOWN",
					status: payload && payload.status ? payload.status : null,
					// Set for ABUSE_THROTTLED: when (epoch ms) polling resumes.
					retryAt: payload && payload.retryAt ? payload.retryAt : null
				};
				this.loaded = true;
				this.updateDom(this.config.animationSpeed);
				break;

			default:
				break;
		}
	},

	/**
	 * Module header, annotated with a staleness marker while polls are failing.
	 * @returns {string} Header text.
	 */
	getHeader () {
		let header = this.data.header || "";
		if (this.failureCount > 0 && this.matches.length > 0) {
			header += ` (${this.translate("STALE")})`;
		}
		return header;
	},

	/**
	 * Build the module DOM.
	 * @returns {HTMLElement} The wrapper element.
	 */
	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = `mmm-livetennis ${this.config.tableClass}`;

		// --- state: loading ------------------------------------------------
		if (!this.loaded) {
			wrapper.classList.add("dimmed", "light");
			wrapper.textContent = this.translate("LOADING");
			return wrapper;
		}

		// --- state: hard error with nothing to fall back on ----------------
		const nothingToShow = this.matches.length === 0 && this.upcoming.length === 0;
		if (this.error && nothingToShow) {
			wrapper.appendChild(this.buildErrorNode());
			return wrapper;
		}

		// --- state: empty ---------------------------------------------------
		if (nothingToShow) {
			if (this.config.hideWhenEmpty) {
				wrapper.classList.add("mmm-livetennis-hidden");
				return wrapper;
			}
			wrapper.classList.add("dimmed", "light");
			wrapper.textContent = this.translate("NO_MATCHES");
			return wrapper;
		}

		// --- state: content --------------------------------------------------
		const table = document.createElement("table");
		table.className = "mmm-livetennis-table";

		const live = this.matches.slice(0, Math.max(0, this.config.maximumEntries));
		for (const match of live) {
			this.appendMatch(table, match, true);
		}

		if (this.config.showUpcoming && this.upcoming.length > 0) {
			const room = Math.max(0, this.config.upcomingEntries);
			const next = this.upcoming.slice(0, room);
			if (next.length > 0) {
				table.appendChild(this.buildSectionRow(this.translate("UPCOMING")));
				for (const match of next) {
					this.appendMatch(table, match, false);
				}
			}
		}

		wrapper.appendChild(table);

		// A soft error banner under existing content (data is stale, not gone).
		if (this.error) {
			const note = this.buildErrorNode();
			note.classList.add("mmm-livetennis-inline-error");
			wrapper.appendChild(note);
		}

		if (this.config.showFooter && this.lastUpdated) {
			wrapper.appendChild(this.buildFooter());
		}

		return wrapper;
	},

	// ---------------------------------------------------------------------
	// DOM builders
	// ---------------------------------------------------------------------

	/**
	 * Append the rows for a single match to the table.
	 * @param {HTMLElement} table Target table element.
	 * @param {object} match Normalised match object.
	 * @param {boolean} isLive Whether the match is in-play.
	 */
	appendMatch (table, match, isLive) {
		if (this.config.showTournament) {
			const caption = this.buildCaption(match, isLive);
			if (caption) table.appendChild(caption);
		}

		const players = Array.isArray(match.players) ? match.players : [];
		const setCount = this.setColumnCount(match);

		for (const player of players) {
			table.appendChild(this.buildPlayerRow(player, match, isLive, setCount));
		}

		const spacer = document.createElement("tr");
		spacer.className = "mmm-livetennis-spacer";
		const spacerCell = document.createElement("td");
		spacerCell.colSpan = 3 + setCount;
		spacer.appendChild(spacerCell);
		table.appendChild(spacer);
	},

	/**
	 * Build the tournament / round caption row.
	 * @param {object} match Normalised match object.
	 * @param {boolean} isLive Whether the match is in-play.
	 * @returns {HTMLElement|null} The caption row or null.
	 */
	buildCaption (match, isLive) {
		const bits = [];
		if (match.tournament) bits.push(match.tournament);
		if (match.round) bits.push(match.round);
		if (!isLive && match.startTime) bits.push(this.formatTime(match.startTime));
		if (bits.length === 0) return null;

		const row = document.createElement("tr");
		row.className = "mmm-livetennis-caption dimmed xsmall";
		const cell = document.createElement("td");
		cell.colSpan = 3 + this.setColumnCount(match);
		cell.textContent = bits.join(" · ");
		row.appendChild(cell);
		return row;
	},

	/**
	 * Build a section separator row (e.g. "Upcoming").
	 * @param {string} label Section label.
	 * @returns {HTMLElement} The section row.
	 */
	buildSectionRow (label) {
		const row = document.createElement("tr");
		row.className = "mmm-livetennis-section dimmed xsmall";
		const cell = document.createElement("td");
		cell.colSpan = 8;
		cell.textContent = label;
		row.appendChild(cell);
		return row;
	},

	/**
	 * Build one player row: serve indicator, name, set scores, current points.
	 * @param {object} player Normalised player object.
	 * @param {object} match Parent match.
	 * @param {boolean} isLive Whether the match is in-play.
	 * @param {number} setCount Number of set columns to render.
	 * @returns {HTMLElement} The player row.
	 */
	buildPlayerRow (player, match, isLive, setCount) {
		const row = document.createElement("tr");
		row.className = "mmm-livetennis-player";
		if (player.winner) row.classList.add("bright");

		// Serving indicator ------------------------------------------------
		const serveCell = document.createElement("td");
		serveCell.className = "mmm-livetennis-serve";
		if (this.config.showServingIndicator && isLive && player.serving) {
			const icon = document.createElement("span");
			icon.className = "fa fa-circle mmm-livetennis-serving";
			icon.setAttribute("aria-label", this.translate("SERVING"));
			icon.setAttribute("title", this.translate("SERVING"));
			serveCell.appendChild(icon);
		}
		row.appendChild(serveCell);

		// Player name ---------------------------------------------------------
		const nameCell = document.createElement("td");
		nameCell.className = "mmm-livetennis-name";
		nameCell.textContent = player.name || this.translate("UNKNOWN_PLAYER");
		if (player.seed) {
			const seed = document.createElement("span");
			seed.className = "mmm-livetennis-seed dimmed";
			seed.textContent = ` (${player.seed})`;
			nameCell.appendChild(seed);
		}
		row.appendChild(nameCell);

		// Set scores ------------------------------------------------------------
		if (this.config.showSets) {
			const sets = Array.isArray(player.sets) ? player.sets : [];
			for (let i = 0; i < setCount; i++) {
				const cell = document.createElement("td");
				cell.className = "mmm-livetennis-set";
				const value = sets[i];
				cell.textContent = (value === undefined || value === null) ? "" : String(value);
				if (i === sets.length - 1 && isLive) cell.classList.add("bright");
				row.appendChild(cell);
			}
		}

		// Current game points -------------------------------------------------
		const pointCell = document.createElement("td");
		pointCell.className = "mmm-livetennis-points";
		if (this.config.showGamePoints && isLive && player.points !== undefined && player.points !== null) {
			pointCell.textContent = String(player.points);
			pointCell.classList.add("bright");
		} else if (!isLive && match.startTime && !this.config.showTournament) {
			pointCell.textContent = this.formatTime(match.startTime);
			pointCell.classList.add("dimmed");
		}
		row.appendChild(pointCell);

		return row;
	},

	/**
	 * Build the error node for the current error state.
	 * @returns {HTMLElement} The error element.
	 */
	buildErrorNode () {
		const node = document.createElement("div");
		node.className = "mmm-livetennis-error dimmed light xsmall";

		if (this.error && this.error.kind === "ABUSE_THROTTLED") {
			// The API paused this key; say so, with the resume time when known.
			const time = this.error.retryAt ? this.formatTime(this.error.retryAt) : "";
			node.textContent = time
				? this.translate("ERROR_ABUSE_UNTIL", { time })
				: this.translate("ERROR_ABUSE");
			return node;
		}

		let key = "ERROR_GENERIC";
		if (this.error) {
			if (this.error.kind === "AUTH") key = "ERROR_AUTH";
			else if (this.error.kind === "NO_KEY") key = "ERROR_NO_KEY";
			else if (this.error.kind === "RATE_LIMIT") key = "ERROR_RATE_LIMIT";
			else if (this.error.kind === "NETWORK") key = "ERROR_NETWORK";
		}
		node.textContent = this.translate(key);
		return node;
	},

	/**
	 * Build the "Updated hh:mm" footer.
	 * @returns {HTMLElement} The footer element.
	 */
	buildFooter () {
		const footer = document.createElement("div");
		footer.className = "mmm-livetennis-footer dimmed xsmall";
		footer.textContent = this.translate("UPDATED", { time: this.formatTime(this.lastUpdated) });
		return footer;
	},

	// ---------------------------------------------------------------------
	// helpers
	// ---------------------------------------------------------------------

	/**
	 * How many set columns this match needs.
	 * @param {object} match Normalised match object.
	 * @returns {number} Column count (at least 1 when sets are shown).
	 */
	setColumnCount (match) {
		if (!this.config.showSets) return 0;
		const players = Array.isArray(match.players) ? match.players : [];
		let max = 0;
		for (const player of players) {
			if (Array.isArray(player.sets)) max = Math.max(max, player.sets.length);
		}
		return Math.max(max, 1);
	},

	/**
	 * Format a timestamp for display, honouring the mirror's timeFormat.
	 * @param {string|number} value ISO string or epoch millis.
	 * @returns {string} Formatted local time, or "" when unparseable.
	 */
	formatTime (value) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "";
		const use12 = (typeof config !== "undefined" && config.timeFormat === 12);
		return date.toLocaleTimeString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			hour12: use12
		});
	}
});
