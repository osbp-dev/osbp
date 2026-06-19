import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

describe("adapter context bundle", () => {
  it("is deterministic and current in --check mode", async () => {
    const scriptPath = join(REPO_ROOT, "scripts/build-adapter-context.mjs");
    const outputPath = join(REPO_ROOT, "dist/osbp-adapter-context.md");

    const result = await execFileAsync(process.execPath, [scriptPath, "--check"], {
      cwd: REPO_ROOT
    });

    assert.match(result.stdout, /dist\/osbp-adapter-context\.md is current/);

    const bundle = await readFile(outputPath, "utf8");
    assert.match(bundle, /# OSBP Adapter Context Bundle/);
    assert.match(bundle, /## v0\.1\.0 Specification/);
    assert.match(bundle, /## Published JSON Schemas/);
    assert.match(bundle, /## BookingAdapter Interface/);
    assert.match(bundle, /## Conformance Requirements/);
    assert.match(bundle, /schema\.tool_inputs\.booking_create/);
    assert.match(bundle, /## Adapter Starter Skeleton/);
    assert.match(bundle, /class StarterBookingAdapter implements BookingAdapter/);
  });
});
