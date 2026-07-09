#!/usr/bin/env node
// Assembles the v0.1.0 spec README from its parts so the protocol body
// (_parts/spec-body.md) can be the single source of truth shared with osbp-site.
// The README is generated output: edit the parts, not the README.
//   build:  node scripts/build-spec.mjs
//   check:  node scripts/build-spec.mjs --check   (fails if README is stale)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const specDir = join(repoRoot, "docs/spec/v0.1.0");
const readmePath = join(specDir, "README.md");

const read = (name) => readFileSync(join(specDir, "_parts", name), "utf8").trim();

// The README is assembled from the platform-agnostic parts only. Adapter-specific
// notes live under integrations/<version>/<platform>/ so the generated spec and
// adapter-context bundle cannot grow platform vocabulary by accident.
const LEADING_PARTS = ["preamble.md", "spec-body.md"];

const assembled = LEADING_PARTS.map(read).join("\n\n") + "\n";

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
