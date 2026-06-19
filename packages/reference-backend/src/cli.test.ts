import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

describe("reference-backend CLI", () => {
  it("prints usage and the known verticals when run with no args", () => {
    const result = runCli([]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /Verticals: dental, auto, notary, spa/);
  });

  it("runs a read-only smoke across every seeded organization", () => {
    const result = runCli(["--smoke"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /services, .* location\(s\), .* smoke slot\(s\)/);
  });

  it("renders a demo for a known vertical at a fixed instant", () => {
    const result = runCli(["--demo", "--now", "2030-01-01T09:00:00Z", "--vertical", "auto"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OSBP reference-backend demo/);
    assert.match(result.stdout, /Clock: 2030-01-01T09:00:00/);
  });

  it("exits nonzero with a validation message for an invalid --now", () => {
    const result = runCli(["--demo", "--now", "not-a-date"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid --now value/);
  });

  it("exits nonzero for an unknown demo vertical", () => {
    const result = runCli(["--demo", "--vertical", "does-not-exist"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown demo vertical/);
  });

  it("rejects a non-numeric pacing flag", () => {
    const result = runCli(["--demo", "--pace-ms", "abc"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--pace-ms must be a non-negative number/);
  });

  it("rejects a flag that is missing its value", () => {
    const result = runCli(["--demo", "--now"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--now requires a value/);
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
