#!/bin/sh
# Local dependency-vulnerability scan for OSBP using osv-scanner.
set -u

if ! command -v osv-scanner >/dev/null 2>&1; then
  echo "osv-scanner not found. Install it with:  brew install osv-scanner" >&2
  exit 127
fi

osv-scanner scan source --lockfile package-lock.json "$@"
status=$?

echo
case "$status" in
  0) echo "osv-scanner: no known vulnerabilities in dependencies." ;;
  1) echo "osv-scanner: vulnerable dependencies reported above." >&2 ;;
  *) echo "osv-scanner failed (exit $status)." >&2 ;;
esac
exit "$status"
