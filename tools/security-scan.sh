#!/bin/sh
# Run all local OSBP security scanners: Semgrep SAST and osv-scanner
# dependency vulnerability checks. Extra args are passed to Semgrep.
set -u
dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

rc=0
sh "$dir/semgrep-scan.sh" "$@" || rc=1
echo
echo "----------------------------------------"
sh "$dir/osv-scan.sh" || rc=1
exit "$rc"
