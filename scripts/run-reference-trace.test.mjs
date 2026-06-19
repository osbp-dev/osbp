import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("run-reference-trace replays one checked-in synthetic trace", () => {
  const result = spawnSync(process.execPath, ["scripts/run-reference-trace.mjs", "traces/v0.1.0/reference-dental-booking-create.json"], {
    cwd: root,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Runner: scripts\/run-reference-trace\.mjs/);
  assert.match(result.stdout, /Scenario: Dental cleaning booked inside a mandate\n\nUser Request: Book a regular cleaning at Carolyn's Dental, up to \$150\.00\. The agent selects Dr\. Mina Lee at 09:00, and the BookingMandate records that exact service, provider, slot, and price cap\.\n\nBooking Mandate: mandate_8f44d4ab-8c56-4f6d-9e0f-d5d3e2d36f88 allows booking\.create; service dental_cleaning; provider dental_dr_lee; schedule dental_midtown; window 2026-07-07T09:00:00\.\.2026-07-07T09:45:00; max \$150\.00\n\nResult: replayed 5 step\(s\)/);
  assert.match(result.stdout, /Guardrail triggered: none/);
  assert.match(result.stdout, /Trace file: traces\/v0\.1\.0\/reference-dental-booking-create\.json/);
});

test("run-reference-trace replays the launch trace gallery by default", () => {
  const result = spawnSync(process.execPath, ["scripts/run-reference-trace.mjs"], {
    cwd: root,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const file of [
    "reference-dental-booking-create.json",
    "reference-dental-fail-closed-guardrails.json",
    "reference-notary-remote-service.json",
    "reference-auto-timezone-currency.json",
    "reference-dental-idempotent-retry.json"
  ]) {
    assert.match(result.stdout, new RegExp(`Trace file: traces/v0\\.1\\.0/${file}`));
  }
  assert.match(result.stdout, /Scenario: Dental booking guardrails fail closed/);
  assert.match(result.stdout, /Scenario: Remote notarization booked without a street address/);
  assert.match(result.stdout, /Scenario: Berlin auto service uses EUR and merchant-local time/);
  assert.match(result.stdout, /Scenario: Dental booking retry returns the same receipt/);
  assert.match(result.stdout, /Scenario: Dental booking guardrails fail closed\n\nUser Request: Book a crown if it is under \$150, and book a new-patient exam only if it can be booked directly\. The agent selects concrete dental options, and OSBP checks them against the user's caps and direct-booking boundary\.\n\nBooking Mandate: 2 mandates\nMandate 1: mandate_f89d3251-4b73-4d40-8b28-6f7a2e8d00f6 allows booking\.create; service dental_crown; provider dental_dr_lee; schedule dental_midtown; window 2026-07-07T09:00:00\.\.2026-07-07T10:30:00; max \$150\.00\nMandate 2: mandate_9d78d205-32f8-490d-b1f5-2277abf85122 allows booking\.create; service dental_new_patient_exam; provider dental_dr_lee; schedule dental_midtown; window 2026-07-07T09:00:00\.\.2026-07-07T10:00:00; max \$250\.00\n\nResult: replayed 2 step\(s\)/);
  assert.match(result.stdout, /Trace file: traces\/v0\.1\.0\/reference-dental-booking-create\.json\n\n-{72}\n\nRunner: scripts\/run-reference-trace\.mjs/);
  assert.match(result.stdout, /Guardrail triggered: price_exceeds_mandate, requires_consultation_handoff, no platform write/);
  assert.match(result.stdout, /Idempotency: same key replayed booking bk_01jz7f2szt8h7q6m5n4p3r2v9k; changed payload rejected/);
});

test("run-reference-trace can print ANSI color hints when requested", () => {
  const result = spawnSync(process.execPath, ["scripts/run-reference-trace.mjs", "traces/v0.1.0/reference-dental-booking-create.json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, OSBP_TRACE_COLOR: "1" }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\u001b\[1mScenario:\u001b\[0m Dental cleaning booked inside a mandate/);
  assert.match(result.stdout, /\u001b\[1mUser Request:\u001b\[0m Book a regular cleaning at Carolyn's Dental/);
  assert.match(result.stdout, /\u001b\[36mBooking Mandate:\u001b\[0m mandate_8f44d4ab-8c56-4f6d-9e0f-d5d3e2d36f88/);
  assert.match(result.stdout, /\u001b\[32mGuardrail triggered:\u001b\[0m none/);
});
