import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonlAuditLog } from "./audit.js";

describe("JsonlAuditLog", () => {
  it("records redacted JSONL audit events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbp-audit-"));
    const path = join(dir, "events.jsonl");
    const auditLog = new JsonlAuditLog(path);

    const event = await auditLog.record({
      tool_name: "booking.create",
      input: {
        mandate: {
          id: "mandate_1"
        },
        customer: {
          phone: "+15555550100"
        },
        verification_code: "123456"
      },
      result: {
        ok: true,
        value: {
          id: "receipt_1",
          text: "Booked."
        }
      },
      platform: { vendor: "openings", api_version: "v1" },
      upstream: {
        call: "POST /v1/appointments/create",
        status: 200,
        server: "Fly/test",
        request_id: "req_1"
      }
    });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    assert.equal(parsed.id, event.id);
    assert.equal(parsed.mandate_id, "mandate_1");
    assert.equal(parsed.tool_name, "booking.create");
    assert.deepEqual(parsed.platform, { vendor: "openings", api_version: "v1" });
    assert.deepEqual(parsed.upstream, {
      call: "POST /v1/appointments/create",
      status: 200,
      server: "Fly/test",
      request_id: "req_1"
    });
    assert.equal(typeof parsed.input_hash, "string");
    assert.equal(typeof parsed.result_hash, "string");
    assert.equal(JSON.stringify(parsed).includes("+15555550100"), false);
    assert.equal(JSON.stringify(parsed).includes("123456"), false);
    assert.equal(JSON.stringify(parsed).includes("[redacted]"), true);
  });

  it("creates the audit log owner-only (0600)", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbp-audit-mode-"));
    const path = join(dir, "nested", "events.jsonl");
    const auditLog = new JsonlAuditLog(path);

    await auditLog.record({
      tool_name: "service.describe",
      input: {},
      result: { ok: true, value: {} }
    });

    // Audit events carry capability-shaped values; a process under a permissive
    // umask must not read them by default.
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("preserves Problem.code while redacting a verification code under the same key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbp-audit-"));
    const path = join(dir, "events.jsonl");
    const auditLog = new JsonlAuditLog(path);

    // verification.verify carries the raw OTP under a key named exactly "code"
    // (VerificationVerifyInput.code), and the failing result carries the closed
    // protocol enum under Problem.code. Both share the key name; only the OTP is
    // sensitive.
    await auditLog.record({
      tool_name: "verification.verify",
      input: { customer: { phone: "+15555550100" }, code: "987654" },
      result: {
        ok: false,
        problem: { code: "verification_failed", message: "Verification code did not match", retryable: false }
      }
    });

    const parsed = JSON.parse(readFileSync(path, "utf8").trim()) as {
      input: { code?: string };
      result: { problem: { code?: string } };
    };

    // Protocol enum preserved for debuggability.
    assert.equal(parsed.result.problem.code, "verification_failed");
    // Raw OTP never reaches the log.
    assert.equal(parsed.input.code, "[redacted]");
    assert.equal(JSON.stringify(parsed).includes("987654"), false);
  });
});
