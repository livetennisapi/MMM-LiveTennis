# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
