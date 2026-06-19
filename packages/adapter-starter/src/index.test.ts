import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AdapterResult,
  AvailabilityFindInput,
  Booking,
  BookingCreateInput,
  BookingStatusInput,
  Policy,
  PolicyExplainInput,
  Receipt,
  Service,
  ServiceDescribeInput,
  Slot,
  VerificationChallenge,
  VerificationSendInput,
  VerificationVerifyInput
} from "@osbp/core";
import { runConformance } from "@osbp/conformance";
import { conformanceFixtures } from "./conformance-target.js";
import { StarterBookingAdapter, type StarterBookingAdapterConfig } from "./index.js";

describe("StarterBookingAdapter", () => {
  it("fails conformance honestly with adapter_not_implemented until mapped", async () => {
    const report = await runConformance(new StarterBookingAdapter(starterConfig()));

    assert.equal(report.passed, false);
    assert.equal(report.summary.total, 44);
    assert.deepEqual(failedProblemCodes(report), ["adapter_not_implemented"]);
    assert.ok(report.checks
      .filter((check) => check.status === "fail")
      .every((check) => check.detail?.includes("adapter_not_implemented")));
    assert.deepEqual(failedCheckIds(report), [
      "happy_path.create_status_receipt",
      "idempotency.conflict_different_payload",
      "idempotency.replay_same_payload",
      "mandate.action_not_allowed",
      "mandate.currency_mismatch.eur",
      "mandate.currency_mismatch.gbp",
      "mandate.invalid_mandate.expires_at",
      "mandate.invalid_mandate.wall_clock_offset",
      "mandate.mandate_expired",
      "mandate.organization_not_allowed",
      "mandate.price_exceeds_mandate",
      "mandate.provider_not_allowed",
      "mandate.provider_unknown",
      "mandate.requires_consultation_handoff",
      "mandate.requires_payment_handoff.deposit",
      "mandate.requires_payment_handoff.full_prepay",
      "mandate.requires_user_confirmation.insurance_dependent",
      "mandate.requires_user_confirmation.quote_required",
      "mandate.requires_user_confirmation.unknown_payment",
      "mandate.schedule_not_allowed",
      "mandate.service_not_allowed",
      "mandate.slot_too_early",
      "mandate.slot_too_late",
      "shape.booking.status_enum",
      "shape.ids.organization_booking",
      "shape.money.fixed_minor_units",
      "shape.money.jpy_minor_units",
      "shape.money.kwd_minor_units",
      "shape.money.non_fixed_absent_amount",
      "shape.operating_hours.iso_weekday",
      "shape.service.duration_iso8601",
      "shape.service.option_duration_iso8601",
      "shape.slot.denormalized_context",
      "shape.slot.time_pair",
      "time.instants_have_offsets",
      "time.wall_clock_no_offsets",
      "verification.required_then_code_books"
    ]);
  });

  it("lets an implemented read method flip its requirement from fail to pass", async () => {
    const unimplemented = await runConformance(new StarterBookingAdapter(starterConfig()));
    const implemented = await runConformance(new ServiceOnlyStarterAdapter(starterConfig()));

    assertCheck(unimplemented, "shape.service.duration_iso8601", "fail");
    assertCheck(implemented, "shape.service.duration_iso8601", "pass");
  });

  it("keeps expected prices keyed to the conformance service fixture ids", () => {
    assertExpectedPrice("fixed_usd", "USD");
    assertExpectedPrice("fixed_eur", "EUR");
    assertExpectedPrice("fixed_gbp", "GBP");
    assertExpectedPrice("fixed_jpy", "JPY");
    assertExpectedPrice("fixed_kwd", "KWD");
  });
});

function starterConfig(): StarterBookingAdapterConfig {
  return {
    apiBaseUrl: "https://vendor.example",
    organizationId: "org_synthetic",
    credentials: {
      apiKey: "test-api-key"
    }
  };
}

function failedCheckIds(report: Awaited<ReturnType<typeof runConformance>>): string[] {
  return report.checks
    .filter((check) => check.status === "fail")
    .map((check) => check.id)
    .sort();
}

function failedProblemCodes(report: Awaited<ReturnType<typeof runConformance>>): string[] {
  return [
    ...new Set(
      report.checks
        .filter((check) => check.status === "fail")
        .flatMap((check) => check.detail?.match(/adapter_not_implemented/g) ?? [])
    )
  ].sort();
}

function assertCheck(
  report: Awaited<ReturnType<typeof runConformance>>,
  id: string,
  status: "pass" | "fail" | "skip"
): void {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert.ok(check, `missing conformance check ${id}`);
  assert.equal(check.status, status, check.detail);
}

function assertExpectedPrice(
  key: "fixed_usd" | "fixed_eur" | "fixed_gbp" | "fixed_jpy" | "fixed_kwd",
  currency: string
): void {
  const serviceId = conformanceFixtures.services?.[key];
  assert.ok(serviceId, `${key} service fixture is configured`);
  assert.equal(conformanceFixtures.expected_prices?.[serviceId]?.currency, currency);
}

class ServiceOnlyStarterAdapter extends StarterBookingAdapter {
  override async describeService(input: ServiceDescribeInput): Promise<AdapterResult<Service>> {
    if (input.service_id !== "svc_fixed_usd") {
      return super.describeService(input);
    }

    return {
      ok: true,
      value: {
        id: "svc_fixed_usd",
        name: "Fixed USD service",
        duration: "PT45M",
        price: {
          amount_minor: 9500,
          currency: "USD",
          type: "fixed"
        },
        options: [
          {
            id: "opt_conditioner",
            name: "Conditioning add-on",
            duration: "PT15M",
            price: {
              amount_minor: 2000,
              currency: "USD",
              type: "fixed"
            }
          }
        ]
      }
    };
  }

  override async findAvailability(input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>> {
    return super.findAvailability(input);
  }

  override async explainPolicy(input: PolicyExplainInput): Promise<AdapterResult<Policy>> {
    return super.explainPolicy(input);
  }

  override async sendVerification(input: VerificationSendInput): Promise<AdapterResult<VerificationChallenge>> {
    return super.sendVerification(input);
  }

  override async verifyCode(input: VerificationVerifyInput): Promise<AdapterResult<VerificationChallenge>> {
    return super.verifyCode(input);
  }

  override async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    return super.createBooking(input);
  }

  override async getBooking(input: BookingStatusInput): Promise<AdapterResult<Booking>> {
    return super.getBooking(input);
  }
}
