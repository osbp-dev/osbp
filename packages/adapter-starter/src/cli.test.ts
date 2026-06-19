import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

describe("adapter-starter CLI", () => {
  it("prints build identity and usage for --help", () => {
    const result = runCli(["--help"]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /osbp-adapter-starter/);
    assert.match(result.stdout, /Usage: osbp-adapter-starter --conformance/);
  });

  it("exits 1 and prints usage when --conformance is absent", () => {
    const result = runCli([]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Usage: osbp-adapter-starter --conformance/);
  });

  it("emits parseable conformance JSON for --conformance --json", () => {
    const result = runCli(["--conformance", "--json"]);
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
