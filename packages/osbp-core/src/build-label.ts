import { statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Returns a build-identity string for any compiled OSBP binary.
 * Pass `import.meta.url` from the binary's entry-point module.
 *
 * Output: "built 2026-06-18 03:02 UTC | git:abc1234"
 *
 * - "built ..." is the mtime of the compiled binary file itself, not the source
 *   commit date. It reflects exactly when `npm run build` last ran.
 * - "git:..." is the short hash of HEAD at the time `buildLabel` is called
 *   (i.e., at runtime, not at compile time). In normal use these are the same
 *   commit, but they diverge if the repo was committed after the last build.
 *
 * Falls back gracefully: omits the timestamp if the file is unreadable, omits
 * the hash if git is unavailable, returns "" if both fail (callers suppress
 * the empty string rather than appending " | ").
 *
 * See AGENTS.md "Build Identity" for the house standard and usage patterns.
 */
export function buildLabel(importMetaUrl: string): string {
  const parts: string[] = [];

  try {
    const { mtime } = statSync(fileURLToPath(importMetaUrl));
    parts.push(`built ${mtime.toISOString().replace("T", " ").slice(0, 16)} UTC`);
  } catch { /* dist binary not readable */ }

  try {
    const binDir = dirname(fileURLToPath(importMetaUrl));
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: binDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    parts.push(`git:${hash}`);
  } catch { /* git not available in this environment */ }

  return parts.join(" | ");
}
