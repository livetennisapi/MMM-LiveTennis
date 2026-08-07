# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-07

### Added

- `abuse_throttled` (429) handling: when the API blocks a key for chronically
  polling over its cap, the helper now pauses all polling until the response's
  `retry_at_epoch` (clamped to 1 min – 24 h; 1 h when absent) instead of
  retrying on `retryDelay`, and the module shows a dedicated "key paused"
  message with the resume time (`ERROR_ABUSE` / `ERROR_ABUSE_UNTIL` in all
  five languages).
- Full tour coverage: `tour` now accepts all five tours — `atp`, `wta`,
  `challenger`, `itf`, `juniors`. Values are lowercased before being sent
  (the API's enum is lowercase and rejects unknown values with a 400), so
  existing `"ATP"` / `"WTA"` configs keep working.
- Mock API scenario `/s/abuse/…` for previewing the throttled state.
- `scripts/truthcheck.sh` + CI step pinning quota and URL copy to product truth.

### Changed

- Requests now authenticate with `Authorization: Bearer <key>` — the API's
  preferred scheme — instead of the `X-API-Key` header (which the API still
  accepts).
- README brought to the org standard: quota grid table (2026-08-06 grid),
  endpoint tier gates, canonical docs link (docs.livetennisapi.com), CI and
  license badges, links block.

## [1.0.0] - 2026-07-26

### Added

- Initial release.
- Live match rendering: players, seeds, per-set game scores, current game points and a serving indicator.
- Optional "Upcoming" section fed by `GET /matches?status=upcoming`.
- Distinct loading, empty, and error states with dedicated translation keys
  (`ERROR_NO_KEY`, `ERROR_AUTH`, `ERROR_RATE_LIMIT`, `ERROR_NETWORK`, `ERROR_GENERIC`).
- Stale-data tolerance: the last good scoreboard stays on screen while polls fail,
  and the header is annotated with a stale marker.
- Server-side-only API key handling, with support for the `LIVETENNIS_API_KEY`
  environment variable and for MagicMirror²'s `hideConfigSecrets` / `${SECRET_*}` mechanism.
- Translations: English, German, Spanish, French, Dutch.
