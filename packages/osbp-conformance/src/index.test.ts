import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AdapterResult,
  AvailabilityFindInput,
  Booking,
  BookingCreateInput,
  BookingStatusInput,
  PolicyExplainInput,
  Receipt,
  ServiceDescribeInput,
  Slot
} from "@osbp/core";
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
    assertCheck(report, "approval.requires_user_confirmation.final_approval", "pass");
    assertCheck(report, "approval.rejects_forged_token", "pass");
    assertCheck(report, "approval.rejects_token_for_changed_payload", "pass");
    assertCheck(report, "approval.rejects_reused_token_after_success", "pass");
    assertCheck(report, "mandate.policy_fee_exceeds_mandate", "pass");
    assertCheck(report, "mandate.organization_id_reachable", "pass");
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

  it("does not require optional slot presentation fields when a platform omits them", async () => {
    const report = await runConformance(new SparseSlotContextAdapter());

    assertCheck(report, "shape.slot.denormalized_context", "pass");
  });

  it("fails adapters that accept forged or payload-mismatched approval tokens", async () => {
    const report = await runConformance(new TokenIgnoringAdapter());

    assertCheck(report, "approval.rejects_forged_token", "fail");
    assertCheck(report, "approval.rejects_token_for_changed_payload", "fail");
  });

  it("fails adapters that bind approval tokens only to the idempotency key", async () => {
    const report = await runConformance(new KeyOnlyApprovalAdapter());

    assertCheck(report, "approval.rejects_forged_token", "pass");
    assertCheck(report, "approval.rejects_token_for_changed_payload", "fail");
  });

  it("fails adapters that allow an approval token to create a second booking after success", async () => {
    const report = await runConformance(new ReusableApprovalAdapter());

    assertCheck(report, "approval.rejects_token_for_changed_payload", "pass");
    assertCheck(report, "approval.rejects_reused_token_after_success", "fail");
  });

  it("fails adapters that accept an incorrect verification code", async () => {
    const report = await runConformance(new VerificationBypassAdapter());

    assertCheck(report, "verification.required_then_code_books", "fail");
  });

  it("fails recoverable problems that are explicitly non-retryable", async () => {
    const report = await runConformance(new NonRetryableRecoverableAdapter(), {
      create_scenario_adapter: (mode) => {
        const adapter = new NonRetryableRecoverableAdapter();
        adapter.setConformanceMode(mode);
        return adapter;
      }
    });

    assertCheck(report, "verification.required_then_code_books", "fail");
    assertCheck(report, "runtime.slot_taken", "fail");
    assertCheck(report, "runtime.rate_limited", "fail");
  });

  it("fails adapters that leak fixture contact values in Problem messages", async () => {
    const report = await runConformance(new PiiProblemAdapter());

    assertCheck(report, "mandate.invalid_mandate.expires_at", "fail");
  });

  it("fails adapters that ignore the mandate fee cap after policy fees are allowed", async () => {
    const report = await runConformance(new PolicyFeeCapIgnoringAdapter());

    assertCheck(report, "mandate.policy_fee_exceeds_mandate", "fail");
  });

  it("fails terminal confirmation problems that look retryable", async () => {
    const report = await runConformance(new RetryableTerminalConfirmationAdapter());

    assertCheck(report, "mandate.requires_user_confirmation.unknown_payment", "fail");
    assertCheck(report, "mandate.requires_user_confirmation.insurance_dependent", "fail");
    assertCheck(report, "mandate.requires_user_confirmation.quote_required", "fail");
  });

  it("fails adapters whose policy read path hides the mandate organization id", async () => {
    const report = await runConformance(new PolicyWithoutOrganizationAdapter());

    assertCheck(report, "mandate.organization_id_reachable", "fail");
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
      assert.equal(report.summary.total, 51);
      assert.equal(report.summary.failed, 0);
      assert.equal(report.summary.skipped, 0);
      assert.equal(report.summary.passed, 51);
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
  assert.equal(check.status, status, check.detail ?? `${id} status`);
}

class SparseSlotContextAdapter extends ConformanceSyntheticAdapter {
  override async findAvailability(input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>> {
    const result = await super.findAvailability(input);
    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: result.value.map((slot) => {
        const {
          organization_name: _organizationName,
          provider_name: _providerName,
          schedule_latitude: _scheduleLatitude,
          schedule_longitude: _scheduleLongitude,
          ...rest
        } = slot;
        return rest;
      })
    };
  }
}

class TokenIgnoringAdapter extends ConformanceSyntheticAdapter {
  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    if (input.approval?.confirmed === true) {
      return {
        ok: true,
        value: {
          id: `receipt_${input.idempotency_key}`,
          booking_id: `booking_${input.idempotency_key}`,
          text: `Booked ${input.service_id} without checking the approval token.`
        }
      };
    }

    return super.createBooking(input);
  }
}

class KeyOnlyApprovalAdapter extends ConformanceSyntheticAdapter {
  private readonly tokensByIdempotencyKey = new Map<string, string>();

  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    if (input.approval?.confirmed === true) {
      const issuedToken = this.tokensByIdempotencyKey.get(input.idempotency_key);
      if (issuedToken && input.approval.token === issuedToken) {
        return {
          ok: true,
          value: {
            id: `receipt_${input.idempotency_key}_${input.time}`,
            booking_id: `booking_${input.idempotency_key}_${input.time}`,
            text: `Booked ${input.service_id} after checking only the idempotency key.`
          }
        };
      }
    }

    const result = await super.createBooking(input);
    if (!result.ok && result.problem.code === "requires_user_confirmation") {
      const token = result.problem.message.match(/approval\.token="([^"]+)"/)?.[1];
      if (token) {
        this.tokensByIdempotencyKey.set(input.idempotency_key, token);
      }
    }
    return result;
  }
}

class ReusableApprovalAdapter extends ConformanceSyntheticAdapter {
  private readonly issuedTokens = new Set<string>();
  private readonly usedTokens = new Set<string>();

  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    if (
      input.approval?.confirmed === true &&
      this.issuedTokens.has(input.approval.token) &&
      this.usedTokens.has(input.approval.token)
    ) {
      return {
        ok: true,
        value: {
          id: `receipt_reused_${input.idempotency_key}`,
          booking_id: `booking_reused_${input.idempotency_key}`,
          text: `Booked ${input.service_id} by reusing an approval token.`
        }
      };
    }

    const result = await super.createBooking(input);
    if (!result.ok && result.problem.code === "requires_user_confirmation") {
      const token = result.problem.message.match(/approval\.token="([^"]+)"/)?.[1];
      if (token) {
        this.issuedTokens.add(token);
      }
    }
    if (result.ok && input.approval?.token) {
      this.usedTokens.add(input.approval.token);
    }
    return result;
  }
}

class VerificationBypassAdapter extends ConformanceSyntheticAdapter {
  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    if (input.service_id === "svc_verification" && input.verification_code) {
      return super.createBooking({ ...input, verification_code: "123456" });
    }
    return super.createBooking(input);
  }
}

class NonRetryableRecoverableAdapter extends ConformanceSyntheticAdapter {
  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    const result = await super.createBooking(input);
    if (
      !result.ok &&
      ["requires_verification", "slot_taken", "rate_limited"].includes(result.problem.code)
    ) {
      return {
        ok: false,
        problem: {
          ...result.problem,
          retryable: false
        }
      };
    }
    return result;
  }
}

class PiiProblemAdapter extends ConformanceSyntheticAdapter {
  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    const result = await super.createBooking(input);
    if (!result.ok && result.problem.code === "invalid_mandate") {
      return {
        ok: false,
        problem: {
          ...result.problem,
          message: `${result.problem.message} Customer phone ${input.customer?.phone ?? ""}.`
        }
      };
    }
    return result;
  }
}

class PolicyFeeCapIgnoringAdapter extends ConformanceSyntheticAdapter {
  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    if (input.service_id === "svc_deposit" && input.mandate.allow_policy_fee === true) {
      return {
        ok: false,
        problem: {
          code: "requires_user_confirmation",
          message: "Deposit approved without checking max_extra_fee. Retry with approval.token=\"unsafe\".",
          retryable: true
        }
      };
    }
    return super.createBooking(input);
  }
}

class RetryableTerminalConfirmationAdapter extends ConformanceSyntheticAdapter {
  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    const result = await super.createBooking(input);
    if (
      !result.ok &&
      result.problem.code === "requires_user_confirmation" &&
      [
        "svc_unknown_payment",
        "svc_insurance",
        "svc_quote"
      ].includes(input.service_id)
    ) {
      return {
        ok: false,
        problem: {
          ...result.problem,
          message: `${result.problem.message} Retry with approval.token="unsafe".`,
          retryable: true
        }
      };
    }

    return result;
  }
}

class PolicyWithoutOrganizationAdapter extends ConformanceSyntheticAdapter {
  override async explainPolicy(input: PolicyExplainInput): Promise<Awaited<ReturnType<ConformanceSyntheticAdapter["explainPolicy"]>>> {
    const result = await super.explainPolicy(input);
    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      value: {
        ...result.value,
        organization: undefined
      }
    };
  }
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
