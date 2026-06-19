#!/usr/bin/env node
// Assembles the v0.1.0 spec README from its parts so the protocol body
// (_parts/spec-body.md) can be the single source of truth shared with osbp-site.
// The README is generated output: edit the parts, not the README.
//   build:  node scripts/build-spec.mjs
//   check:  node scripts/build-spec.mjs --check   (fails if README is stale)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const specDir = join(repoRoot, "docs/spec/v0.1.0");
const readmePath = join(specDir, "README.md");

const read = (name) => readFileSync(join(specDir, "_parts", name), "utf8").trim();

// The README is assembled from _parts in order: preamble, spec-body, then any
// additional _parts/*.md (sorted). An extra part carries adapter-specific notes
// that ship only in a cut which includes the matching adapter; a cut that omits
// an extra part omits its README section too, so `build-spec --check` stays
// green in both the full and the minimal public builds.
const LEADING_PARTS = ["preamble.md", "spec-body.md"];
const extraParts = readdirSync(join(specDir, "_parts"))
  .filter((name) => name.endsWith(".md") && !LEADING_PARTS.includes(name))
  .sort();

const assembled = [...LEADING_PARTS, ...extraParts].map(read).join("\n\n") + "\n";

if (process.argv.includes("--check")) {
  const current = readFileSync(readmePath, "utf8");
  if (current !== assembled) {
    console.error(
      "docs/spec/v0.1.0/README.md is stale. Run `npm run build:spec` and commit the result."
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(readmePath, assembled);
  console.log("wrote docs/spec/v0.1.0/README.md");
}
