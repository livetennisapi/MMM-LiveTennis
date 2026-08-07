#!/bin/sh
# truthcheck.sh — fail CI if stale Live Tennis API product facts reappear.
# POSIX sh; needs only git + grep. Run from anywhere inside the repo.
set -u

cd "$(dirname "$0")/.." || exit 1

# Tracked text files. Exempt: CHANGELOG history entries, this script (its
# forbid patterns contain the literals), binaries, and the lockfile.
FILES=$(git ls-files | grep -Ev '^(CHANGELOG\.md|scripts/truthcheck\.sh|screenshot\.png|package-lock\.json)$')

status=0

forbid () {
	pattern="$1"
	label="$2"
	hits=$(printf '%s\n' "$FILES" | xargs grep -inE "$pattern" 2>/dev/null)
	if [ -n "$hits" ]; then
		echo "truthcheck FAIL — forbidden: $label"
		printf '%s\n' "$hits"
		status=1
	fi
}

forbid '(100[, ]?000|100k)[^.]{0,40}(day|daily)' 'stale 100k/day free quota'
forbid 'free[^.]{0,60}(1,?000|1k)( |/)(requests? ?/? ?)?(per )?da(y|ily)' 'free tier paired with 1,000/day'
forbid 'livetennisapi\.com/docs' 'wrong docs URL (canonical: docs.livetennisapi.com)'
forbid 'bensynapse' 'personal handle in repo metadata'
forbid 'midnight UTC' 'daily reset is not midnight UTC'

# If the repo states quotas at all, the current FREE figure and the canonical
# docs host must both be present.
if printf '%s\n' "$FILES" | xargs grep -ilE 'requests?/day|requests? per day' >/dev/null 2>&1; then
	if ! printf '%s\n' "$FILES" | xargs grep -ilE '100 ?(requests)? ?/ ?day|100 requests/day' >/dev/null 2>&1; then
		echo 'truthcheck FAIL — quota copy present but the FREE "100/day" figure is missing'
		status=1
	fi
	if ! printf '%s\n' "$FILES" | xargs grep -il 'docs\.livetennisapi\.com' >/dev/null 2>&1; then
		echo 'truthcheck FAIL — quota copy present but docs.livetennisapi.com is missing'
		status=1
	fi
fi

if [ "$status" -eq 0 ]; then
	echo 'truthcheck OK'
fi
exit "$status"
