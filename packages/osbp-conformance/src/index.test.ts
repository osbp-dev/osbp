import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterResult, Booking, BookingCreateInput, BookingStatusInput, Receipt, ServiceDescribeInput } from "@osbp/core";
import {
  REFERENCE_CONFORMANCE_FIXTURES,
  REFERENCE_CONFORMANCE_ORGANIZATION,
  SyntheticBookingAdapter as ReferenceSyntheticBookingAdapter,
  startSyntheticBookingServer,
  type SyntheticBookingServer as ReferenceSyntheticBookingServer
} from "@osbp/reference-backend";
import {
  createSyntheticBookingAdapter,
  runConformance,
  ConformanceSyntheticAdapter,
  type ConformanceScenarioMode,
  type ConformanceCheckStatus
} from "./index.js";

describe("runConformance", () => {
  it("passes the credential-free synthetic adapter with auditable requirement ids", async () => {
    const report = await runConformance(createSyntheticBookingAdapter());

    assert.equal(report.passed, true);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.total, report.checks.length);
    assert.equal(report.summary.passed, report.checks.filter((check) => check.status === "pass").length);

    const ids = report.checks.map((check) => check.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const check of report.checks) {
      assert.equal(typeof check.requirement, "string");
      assert.notEqual(check.requirement.length, 0);
      assert.match(check.spec_ref, /docs\/spec\/v0\.1\.0\//);
    }

    assertCheck(report, "schema.result_envelope.success", "pass");
    assertCheck(report, "schema.problem.failure", "pass");
    assertCheck(report, "schema.booking_mandate.fixture", "pass");
    assertCheck(report, "shape.service.duration_iso8601", "pass");
    assertCheck(report, "shape.money.jpy_minor_units", "pass");
    assertCheck(report, "shape.money.kwd_minor_units", "pass");
    assertCheck(report, "shape.slot.time_pair", "pass");
    assertCheck(report, "shape.booking.status_enum", "pass");
    assertCheck(report, "mandate.currency_mismatch.eur", "pass");
    assertCheck(report, "mandate.requires_payment_handoff.deposit", "pass");
    assertCheck(report, "mandate.requires_consultation_handoff", "pass");
    assertCheck(report, "idempotency.replay_same_payload", "pass");
    assertCheck(report, "idempotency.conflict_different_payload", "pass");
    assertCheck(report, "verification.required_then_code_books", "pass");
    assertCheck(report, "runtime.slot_taken", "pass");
    assertCheck(report, "runtime.rate_limited", "pass");
    assertCheck(report, "happy_path.create_status_receipt", "pass");
  });

  it("fails adapters that drift from required shapes and fail-closed behavior", async () => {
    const report = await runConformance(new NonconformantAdapter());

    assert.equal(report.passed, false);
    const failedIds = report.checks
      .filter((check) => check.status === "fail")
      .map((check) => check.id)
      .sort();

    assert.deepEqual(failedIds, [
      "mandate.requires_consultation_handoff",
      "shape.booking.status_enum",
      "shape.service.duration_iso8601"
    ]);
  });

  it("passes the full battery against the reference backend conformance fixture", async () => {
    const server = await startSyntheticBookingServer([REFERENCE_CONFORMANCE_ORGANIZATION]);
    try {
      const adapter = new ReferenceSyntheticBookingAdapter({
        apiBaseUrl: server.url,
        organizationId: REFERENCE_CONFORMANCE_FIXTURES.organization_id
      });

      const report = await runConformance(adapter, {
        fixtures: REFERENCE_CONFORMANCE_FIXTURES,
        create_scenario_adapter: async (mode) => {
          await armReferenceScenario(server, REFERENCE_CONFORMANCE_FIXTURES.organization_id, mode);
          return adapter;
        }
      });

      assert.equal(report.passed, true, failedCheckSummary(report));
      assert.equal(report.summary.total, 44);
      assert.equal(report.summary.failed, 0);
      assert.equal(report.summary.skipped, 0);
      assert.equal(report.summary.passed, 44);
    } finally {
      await server.close();
    }
  });
});

function assertCheck(
  report: Awaited<ReturnType<typeof runConformance>>,
  id: string,
  status: ConformanceCheckStatus
): void {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `missing conformance check ${id}`);
  assert.equal(check.status, status, check.detail);
}

async function armReferenceScenario(
  server: ReferenceSyntheticBookingServer,
  organizationId: string,
  mode: ConformanceScenarioMode
): Promise<void> {
  if (mode === "normal") {
    return;
  }
  const response = await fetch(new URL("/test/scenarios", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organization_id: organizationId, next_create: mode })
  });
  assert.equal(response.status, 204);
}

function failedCheckSummary(report: Awaited<ReturnType<typeof runConformance>>): string {
  return report.checks
    .filter((check) => check.status === "fail")
    .map((check) => `${check.id}: ${check.detail ?? "failed"}`)
    .join("\n");
}

class NonconformantAdapter extends ConformanceSyntheticAdapter {
  override async describeService(input: ServiceDescribeInput): Promise<AdapterResult<Awaited<ReturnType<ConformanceSyntheticAdapter["describeService"]>> extends AdapterResult<infer T> ? T : never>> {
    const result = await super.describeService(input);
    if (result.ok && result.value.id === "svc_fixed_usd") {
      return {
        ok: true,
        value: {
          ...result.value,
          duration: 45
        } as unknown as typeof result.value
      };
    }

    return result;
  }

  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    if (input.service_id === "svc_consultation") {
      return {
        ok: true,
        value: {
          id: "receipt_bad_consultation",
          booking_id: "booking_bad_consultation",
          text: "Booked a consultation-only service without handoff."
        }
      };
    }

    return super.createBooking(input);
  }

  override async getBooking(input: BookingStatusInput): Promise<AdapterResult<Booking>> {
    const result = await super.getBooking(input);
    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: {
        ...result.value,
        status: "confirmed"
      } as unknown as Booking
    };
  }
}
