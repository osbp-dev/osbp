import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { defaultAuditLogPath, JsonlAuditLog } from "./audit.js";

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
          phone: "+15555550100",
          display_name: "Jordan Rivera"
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
    assert.equal(JSON.stringify(parsed).includes("Jordan Rivera"), false);
    assert.equal(JSON.stringify(parsed).includes("[redacted]"), true);
  });

  it("redacts provider image URLs from audit results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbp-audit-"));
    const path = join(dir, "events.jsonl");
    const auditLog = new JsonlAuditLog(path);

    await auditLog.record({
      tool_name: "availability.find",
      input: {},
      result: {
        ok: true,
        value: {
          slots: [
            {
              id: "slot_1",
              provider_name: "Amy",
              provider_image_url: "https://img.example/amy.jpg"
            }
          ]
        }
      }
    });

    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text.trim()) as {
      result: { value?: { slots?: Array<{ provider_image_url?: string }> } };
    };

    assert.equal(parsed.result.value?.slots?.[0]?.provider_image_url, "[redacted]");
    assert.equal(text.includes("https://img.example/amy.jpg"), false);
  });

  it("resolves a relative audit env path against the provided base directory", () => {
    assert.equal(
      defaultAuditLogPath({ OSBP_AUDIT_LOG_PATH: ".osbp/audit/custom.jsonl" }, "/repo/root"),
      resolve("/repo/root", ".osbp/audit/custom.jsonl")
    );
  });

  it("extracts mandate_id from top-level handoff input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbp-audit-"));
    const path = join(dir, "events.jsonl");
    const auditLog = new JsonlAuditLog(path);

    await auditLog.record({
      tool_name: "handoff.request",
      input: {
        mandate_id: "mandate_handoff",
        reason: "needs_human",
        message: "Call the salon."
      },
      result: { ok: true, value: { status: "requires_human" } }
    });

    const parsed = JSON.parse(readFileSync(path, "utf8").trim()) as { mandate_id?: string };
    assert.equal(parsed.mandate_id, "mandate_handoff");
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

  it("redacts approval tokens from audit input and problem messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbp-audit-"));
    const path = join(dir, "events.jsonl");
    const auditLog = new JsonlAuditLog(path);

    await auditLog.record({
      tool_name: "booking.create",
      input: {
        approval: {
          confirmed: true,
          token: "approval-secret"
        }
      },
      result: {
        ok: false,
        problem: {
          code: "requires_user_confirmation",
          message:
            "Final user approval is required before booking. User-facing approval summary: Book Haircut. " +
            'Agent retry instruction: retry with approval.confirmed=true and approval.token="approval-secret".',
          retryable: true
        }
      }
    });

    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text.trim()) as {
      input: { approval: { token?: string } };
      result: { problem: { message?: string } };
    };

    assert.equal(parsed.input.approval.token, "[redacted]");
    assert.match(parsed.result.problem.message ?? "", /approval\.token="\[redacted\]"/);
    assert.equal(text.includes("approval-secret"), false);
  });

  it("redacts approval tokens embedded in handoff free text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbp-audit-"));
    const path = join(dir, "events.jsonl");
    const auditLog = new JsonlAuditLog(path);

    await auditLog.record({
      tool_name: "handoff.request",
      input: {
        reason: "verification_failed",
        message: 'Manual follow-up after approval.token="approval-secret".',
        mandate_id: "mandate_1"
      },
      result: {
        ok: true,
        value: {
          status: "requires_human",
          reason: "verification_failed",
          message: 'Manual follow-up after approval.token="approval-secret".',
          mandate_id: "mandate_1"
        }
      }
    });

    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text.trim()) as {
      input: { message?: string };
      result: { value?: { message?: string } };
    };

    assert.equal(text.includes("approval-secret"), false);
    assert.match(parsed.input.message ?? "", /approval\.token="\[redacted\]"/);
    assert.match(parsed.result.value?.message ?? "", /approval\.token="\[redacted\]"/);
  });

  it("redacts customer display names and contact details embedded in free text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbp-audit-"));
    const path = join(dir, "events.jsonl");
    const auditLog = new JsonlAuditLog(path);

    await auditLog.record({
      tool_name: "handoff.request",
      input: {
        customer: {
          display_name: "Jordan Rivera"
        },
        message: "Call Jordan Rivera at +1 (555) 555-0100 or jordan.rivera@example.com."
      },
      result: {
        ok: true,
        value: {
          message: "Escalated for Jordan Rivera at +1 (555) 555-0100."
        }
      }
    });

    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text.trim()) as { input: unknown; result: unknown };
    const redactedPayloadText = JSON.stringify({ input: parsed.input, result: parsed.result });

    assert.equal(redactedPayloadText.includes("Jordan Rivera"), false);
    assert.equal(redactedPayloadText.includes("555"), false);
    assert.equal(redactedPayloadText.includes("jordan.rivera@example.com"), false);
    assert.equal(redactedPayloadText.includes("[redacted]"), true);
  });

  it("redacts structured customer names and their joined form from audit text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "osbp-audit-"));
    const path = join(dir, "events.jsonl");
    const auditLog = new JsonlAuditLog(path);

    await auditLog.record({
      tool_name: "booking.create",
      input: {
        customer: {
          given_name: "Alex",
          family_name: "Smith"
        }
      },
      result: {
        ok: false,
        problem: {
          code: "requires_user_confirmation",
          message: "Final approval required. User-facing approval summary: Book Short Haircut for Alex Smith.",
          retryable: true
        }
      }
    });

    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text.trim()) as {
      input: { customer?: { given_name?: string; family_name?: string } };
      result: { problem?: { message?: string } };
    };

    assert.equal(parsed.input.customer?.given_name, "[redacted]");
    assert.equal(parsed.input.customer?.family_name, "[redacted]");
    assert.equal(text.includes("Alex"), false);
    assert.equal(text.includes("Smith"), false);
    assert.equal(text.includes("Alex Smith"), false);
    assert.match(parsed.result.problem?.message ?? "", /Book Short Haircut for \[redacted\] \[redacted\]/);
  });
});
