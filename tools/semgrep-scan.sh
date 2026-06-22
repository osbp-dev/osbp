#!/bin/sh
# Local SAST for OSBP using Semgrep OSS.
set -u

if ! command -v semgrep >/dev/null 2>&1; then
  echo "semgrep not found. Install it with:  brew install semgrep" >&2
  echo "                             (or:  pipx install semgrep)" >&2
  exit 127
fi

out_dir=".security"
mkdir -p "$out_dir"

semgrep scan \
  --config p/javascript \
  --config p/typescript \
  --config p/secrets \
  --config p/security-audit \
  --metrics=off \
  --error \
  --sarif-output="$out_dir/semgrep.sarif" \
  "$@" \
  .
status=$?

echo
case "$status" in
  0) echo "Semgrep: no findings. SARIF: $out_dir/semgrep.sarif" ;;
  1) echo "Semgrep: findings reported above. SARIF: $out_dir/semgrep.sarif" ;;
  *) echo "Semgrep failed (exit $status)." >&2 ;;
esac
exit "$status"
