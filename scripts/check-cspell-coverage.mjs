#!/usr/bin/env node
// Coverage gate for the PUBLIC cspell dictionary: every word in the shipped
// cspell.json must appear in some shipped, spell-checked file. A word in the
// dictionary but in no shipped file is dead weight at best and a roadmap leak at
// worst: a competitor brand name the public repo has no code or docs for, only a
// spellcheck entry. The leak gate's brand detectors only know a fixed list; this
// catches the general case and fails (exit 1) if any orphan is found.
//
// Runs in two places, so it is self-contained (no imports from the private cut
// libs, which do not ship):
//   - public CI / pre-publish `npm run check`: cwd is the public repo root.
//   - the public-cut driver: `--root <generated tree>`.
//
// Matching is case-insensitive substring over the shipped text, deliberately
// conservative: it never fails on a word the docs actually contain, and reliably
// flags a distinct orphan such as a brand name.
//
// Usage: node scripts/check-cspell-coverage.mjs [--root DIR]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Directories cspell never scans in the public tree (mirrors the cspell.json
// ignorePaths plus the always-skip set). Over-skipping is safe: it can only make
// the gate more lenient, never produce a false failure.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", "traces"]);
// The cspell config files are skipped so the dictionary does not match itself:
// a word listed in cspell.json must be justified by real content, not its own entry.
const SKIP_FILES = new Set(["package-lock.json", "cspell.json", "cspell.public.json"]);
// Extensions cspell checks, from the `spell` script glob. Matching this set keeps
// the gate aligned with what cspell actually reads.
const TEXT_EXT = /\.(md|ts|mts|mjs|json|txt|yml|yaml)$/i;

function readShippedText(root) {
  const chunks = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (!SKIP_FILES.has(entry) && TEXT_EXT.test(entry)) {
        try {
          chunks.push(readFileSync(path, "utf8"));
        } catch {
          // Unreadable file: skip. A word that needed it stays flagged, which is
          // the safe direction for a gate.
        }
      }
    }
  })(root);
  return chunks.join("\n").toLowerCase();
}

// Returns the words from <root>/cspell.json that appear in no shipped,
// spell-checked file under <root>.
export function findCspellOrphans({ root }) {
  const config = JSON.parse(readFileSync(join(root, "cspell.json"), "utf8"));
  const words = config.words ?? [];
  if (words.length === 0) return [];
  const haystack = readShippedText(root);
  return words.filter((word) => !haystack.includes(String(word).toLowerCase()));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf("--root");
  const root = flag !== -1 ? resolve(process.argv[flag + 1]) : process.cwd();
  const orphans = findCspellOrphans({ root });
  if (orphans.length > 0) {
    console.error(
      `cspell coverage: ${orphans.length} dictionary word(s) appear in no shipped file.\n` +
        "Remove them from cspell.public.json, or add the content that uses them:\n" +
        orphans.map((word) => `  - ${word}`).join("\n")
    );
    process.exit(1);
  }
  console.log("cspell coverage: every public dictionary word is used by shipped content.");
}
