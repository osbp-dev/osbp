import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const STARTER_TARGET = fileURLToPath(new URL("../../adapter-starter/dist/conformance-target.js", import.meta.url));

describe("osbp-conformance CLI", () => {
  it("prints build identity and usage for --help", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /osbp-conformance/);
    assert.match(result.stdout, /Usage: osbp-conformance/);
  });

  it("emits parseable JSON with no human banner for --json", () => {
    const result = runCli(["--json"]);
    assert.doesNotMatch(result.stdout, /OSBP conformance report/);
    const report = JSON.parse(result.stdout) as { passed: boolean; summary: { total: number }; checks: unknown[] };
    assert.equal(typeof report.passed, "boolean");
    assert.ok(report.summary.total > 0);
    assert.ok(Array.isArray(report.checks));
  });

  it("exits nonzero and reports the error for an unknown argument", () => {
    const result = runCli(["--bogus"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown argument --bogus/);
  });

  it("exits nonzero when --target has no value", () => {
    const result = runCli(["--target"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--target requires a module path/);
  });

  it("resolves and runs an external target module", () => {
    const result = runCli(["--target", STARTER_TARGET]);
    assert.match(result.stdout, /OSBP conformance report for .*conformance-target\.js/);
    assert.match(result.stdout, /checks passed/);
  });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), ...args], {
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}
