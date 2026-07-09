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
    assert.equal(report.summary.total, 51);
    assert.deepEqual(failedProblemCodes(report), ["adapter_not_implemented"]);
    assert.ok(report.checks
      .filter((check) => check.status === "fail")
      .every((check) => check.detail?.includes("adapter_not_implemented")));
    assert.deepEqual(failedCheckIds(report), [
      "approval.rejects_forged_token",
      "approval.rejects_reused_token_after_success",
      "approval.rejects_token_for_changed_payload",
      "approval.requires_user_confirmation.final_approval",
      "happy_path.create_status_receipt",
      "idempotency.conflict_different_payload",
      "idempotency.replay_same_payload",
      "mandate.action_not_allowed",
      "mandate.currency_mismatch.eur",
      "mandate.currency_mismatch.gbp",
      "mandate.invalid_mandate.expires_at",
      "mandate.invalid_mandate.wall_clock_offset",
      "mandate.mandate_expired",
      "mandate.organization_id_reachable",
      "mandate.organization_not_allowed",
      "mandate.policy_fee_exceeds_mandate",
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
      "mandate.service_empty_scope_denies",
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

  it("requires final approval before reaching the platform-create placeholder", async () => {
    const adapter = new ApprovalReadyStarterAdapter(starterConfig());
    const input = starterBookingInput();

    const first = await adapter.createBooking(input);
    assert.equal(first.ok, false);
    assert.equal(first.ok ? undefined : first.problem.code, "requires_user_confirmation");
    const [summaryText = ""] = first.ok ? [""] : first.problem.message.split("Agent retry instruction:");
    assert.match(summaryText, /Cancellation fee: .*1000 USD minor units/);
    assert.match(summaryText, /No-show fee: .*1500 USD minor units/);
    assert.doesNotMatch(summaryText, /capped by the BookingMandate/i);
    const token = /approval\.token="([^"]+)"/.exec(first.ok ? "" : first.problem.message)?.[1];
    assert.ok(token, "expected starter approval gate to issue a token");

    const approved = await adapter.createBooking({
      ...input,
      approval: { confirmed: true, token }
    });
    assert.equal(approved.ok, false);
    assert.equal(approved.ok ? undefined : approved.problem.code, "adapter_not_implemented");
  });

  it("redacts contact-bearing upstream path segments and captures retry-after", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "retry-after": "45"
        }
      });

      const adapter = new RequestProbeStarterAdapter(starterConfig());
      await adapter.probeRequest("/v1/visits/history/+15555550100");

      assert.equal(adapter.upstreamMeta?.call, "GET /v1/visits/history/:redacted");
      assert.equal(adapter.upstreamMeta?.ratelimit?.["retry-after"], "45");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts requestJson when httpTimeoutMs elapses without dropping request headers", async () => {
    const originalFetch = globalThis.fetch;
    let observedHeaders: Headers | undefined;
    let observedSignal: AbortSignal | undefined;
    try {
      globalThis.fetch = async (_url, init) => {
        observedHeaders = new Headers(init?.headers);
        observedSignal = init?.signal ?? undefined;
        if (!observedSignal) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }

        return new Promise<Response>((resolve, reject) => {
          observedSignal?.addEventListener("abort", () => {
            reject(new Error("request aborted by timeout"));
          }, { once: true });
          setTimeout(() => {
            resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
          }, 50);
        });
      };

      const adapter = new RequestProbeStarterAdapter({
        ...starterConfig(),
        httpTimeoutMs: 5
      });

      await assert.rejects(
        () => adapter.probeRequest("/v1/slow"),
        /request aborted by timeout/
      );
      assert.equal(observedHeaders?.get("x-api-key"), "test-api-key");
      assert.match(observedHeaders?.get("user-agent") ?? "", /^OSBP\/0\.1\.0 adapter-starter\/0\.1\.0 node\//);
      assert.equal(observedSignal?.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects absolute request paths before sending adapter credentials off origin", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    try {
      globalThis.fetch = async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      };

      const adapter = new RequestProbeStarterAdapter(starterConfig());

      await assert.rejects(
        () => adapter.probeRequest("https://attacker.example/v1/bookings"),
        /outside configured API origin/
      );
      assert.equal(fetchCalled, false, "origin guard must reject before fetch can send headers");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("dedupes concurrent approved creates with the same idempotency key", async () => {
    const adapter = new BookingImplementedStarterAdapter(starterConfig());
    const input = starterBookingInput();
    const first = await adapter.createBooking(input);
    const token = /approval\.token="([^"]+)"/.exec(first.ok ? "" : first.problem.message)?.[1];
    assert.ok(token, "expected approval token from first call");
    const approved = {
      ...input,
      approval: { confirmed: true, token } as const
    };

    const firstCreate = adapter.createBooking(approved);
    const secondCreate = adapter.createBooking(approved);
    const [firstResult, secondResult] = await Promise.all([firstCreate, secondCreate]);

    assert.equal(adapter.platformCreateCalls, 1);
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.deepEqual(firstResult, secondResult);
  });

  it("returns a Problem instead of throwing when platform create throws", async () => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    const stderr: string[] = [];
    try {
      console.error = (...args: unknown[]) => {
        stderr.push(args.join(" "));
      };
      globalThis.fetch = async () => new Response("upstream failed for +15555550100", {
        status: 503,
        statusText: "Service Unavailable"
      });

      const adapter = new HttpFailingCreateStarterAdapter(starterConfig());
      const input = starterBookingInput();
      const first = await adapter.createBooking(input);
      const token = /approval\.token="([^"]+)"/.exec(first.ok ? "" : first.problem.message)?.[1];
      assert.ok(token, "expected approval token from first call");

      const result = await adapter.createBooking({
        ...input,
        approval: { confirmed: true, token }
      });

      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.problem.code, "internal_adapter_error");
      assert.equal(result.ok ? undefined : result.problem.retryable, true);
      assert.match(result.ok ? "" : result.problem.message, /HTTP 503/);
      assert.match(result.ok ? "" : result.problem.message, /:redacted/);
      assert.doesNotMatch(result.ok ? "" : result.problem.message, /\+15555550100/);
      assert.deepEqual(stderr, ["[adapter-starter] booking.create HTTP 503 at /v1/visits/history/:redacted"]);
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }
  });

  it("maps upstream create 429 to rate_limited", async () => {
    const originalFetch = globalThis.fetch;
    const originalError = console.error;
    try {
      console.error = () => {};
      globalThis.fetch = async () => new Response("slow down", {
        status: 429,
        statusText: "Too Many Requests"
      });

      const adapter = new HttpFailingCreateStarterAdapter(starterConfig());
      const result = await approvedCreate(adapter);

      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.problem.code, "rate_limited");
      assert.equal(result.ok ? undefined : result.problem.retryable, true);
    } finally {
      globalThis.fetch = originalFetch;
      console.error = originalError;
    }
  });

  it("logs only the error name for unknown create throws", async () => {
    const originalError = console.error;
    const stderr: string[] = [];
    try {
      console.error = (...args: unknown[]) => {
        stderr.push(args.join(" "));
      };

      const adapter = new ThrowingCreateStarterAdapter(starterConfig());
      const result = await approvedCreate(adapter);

      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.problem.code, "internal_adapter_error");
      assert.deepEqual(stderr, ["[adapter-starter] booking.create threw Error"]);
      assert.doesNotMatch(stderr.join("\n"), /\+15555550100|sensitive stack|boom/);
    } finally {
      console.error = originalError;
    }
  });

  it("returns provider-scope mandate problems before slot_taken", async () => {
    const adapter = new ApprovalReadyStarterAdapter(starterConfig());

    const missingProvider = await adapter.createBooking({
      ...starterBookingInput(),
      idempotency_key: "00000000-0000-4000-8000-000000000002",
      provider_id: ""
    });
    assert.equal(missingProvider.ok, false);
    assert.equal(missingProvider.ok ? undefined : missingProvider.problem.code, "provider_unknown");

    const wrongProvider = await adapter.createBooking({
      ...starterBookingInput(),
      idempotency_key: "00000000-0000-4000-8000-000000000003",
      provider_id: "prov_other"
    });
    assert.equal(wrongProvider.ok, false);
    assert.equal(wrongProvider.ok ? undefined : wrongProvider.problem.code, "provider_not_allowed");
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

async function approvedCreate(adapter: StarterBookingAdapter): Promise<AdapterResult<Receipt>> {
  const input = starterBookingInput();
  const first = await adapter.createBooking(input);
  const token = /approval\.token="([^"]+)"/.exec(first.ok ? "" : first.problem.message)?.[1];
  assert.ok(token, "expected approval token from first call");
  return adapter.createBooking({
    ...input,
    approval: { confirmed: true, token }
  });
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

class ApprovalReadyStarterAdapter extends StarterBookingAdapter {
  override async describeService(_input: ServiceDescribeInput): Promise<AdapterResult<Service>> {
    return {
      ok: true,
      value: {
        id: "svc_fixed_usd",
        name: "Haircut",
        duration: "PT45M",
        price: { amount_minor: 9500, currency: "USD", type: "fixed" }
      }
    };
  }

  override async findAvailability(_input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>> {
    return {
      ok: true,
      value: [starterSlot()]
    };
  }

  override async explainPolicy(_input: PolicyExplainInput): Promise<AdapterResult<Policy>> {
    return {
      ok: true,
      value: {
        service_id: "svc_fixed_usd",
        payment_requirement: "none",
        cancellation_fee: { amount_minor: 1000, currency: "USD", type: "fixed" },
        no_show_fee: { amount_minor: 1500, currency: "USD", type: "fixed" },
        organization: {
          id: "org_synthetic",
          name: "Synthetic Studio",
          timezone: "America/Los_Angeles",
          currency: "USD"
        }
      }
    };
  }
}

class RequestProbeStarterAdapter extends StarterBookingAdapter {
  async probeRequest(path: string): Promise<unknown> {
    return this.requestJson(path);
  }
}

class BookingImplementedStarterAdapter extends ApprovalReadyStarterAdapter {
  platformCreateCalls = 0;

  protected async createBookingOnPlatform(
    input: BookingCreateInput
  ): Promise<AdapterResult<{ receipt: Receipt; booking?: Booking }>> {
    this.platformCreateCalls += 1;
    await Promise.resolve();
    const booking: Booking = {
      id: `booking_${input.idempotency_key}`,
      status: "booked",
      service_id: input.service_id,
      schedule_id: input.schedule_id,
      provider_id: input.provider_id,
      starts_at: "2030-05-02T17:00:00Z",
      starts_at_local: "2030-05-02T10:00:00",
      schedule_timezone: "America/Los_Angeles"
    };
    return {
      ok: true,
      value: {
        receipt: {
          id: `receipt_${input.idempotency_key}`,
          booking_id: booking.id,
          text: `Booked ${input.service_id}.`
        },
        booking
      }
    };
  }
}

class HttpFailingCreateStarterAdapter extends ApprovalReadyStarterAdapter {
  protected async createBookingOnPlatform(
    input: BookingCreateInput
  ): Promise<AdapterResult<{ receipt: Receipt; booking?: Booking }>> {
    void input;
    await this.requestJson("/v1/visits/history/+15555550100");
    return {
      ok: true,
      value: {
        receipt: {
          id: "receipt_unreachable",
          booking_id: "booking_unreachable",
          text: "unreachable"
        }
      }
    };
  }
}

class ThrowingCreateStarterAdapter extends ApprovalReadyStarterAdapter {
  protected async createBookingOnPlatform(): Promise<AdapterResult<{ receipt: Receipt; booking?: Booking }>> {
    throw new Error("boom +15555550100 sensitive stack");
  }
}

function starterBookingInput(): BookingCreateInput {
  return {
    mandate: {
      id: "mandate_starter_approval",
      expires_at: "2030-05-01T12:00:00Z",
      allowed_actions: ["booking.create"],
      organization_id: "org_synthetic",
      service_ids: ["svc_fixed_usd"],
      schedule_ids: ["sched_starter"],
      provider_ids: ["prov_starter"],
      earliest_start: "2030-05-02T09:00:00",
      latest_end: "2030-05-02T12:00:00",
      max_price: { amount_minor: 10000, currency: "USD" },
      allow_policy_fee: false
    },
    idempotency_key: "00000000-0000-4000-8000-000000000001",
    service_id: "svc_fixed_usd",
    schedule_id: "sched_starter",
    provider_id: "prov_starter",
    date: "2030-05-02",
    time: "10:00",
    customer: { phone: "+15555550100" }
  };
}

function starterSlot(): Slot {
  return {
    id: "slot_starter_approval",
    organization_id: "org_synthetic",
    schedule_id: "sched_starter",
    provider_id: "prov_starter",
    service_id: "svc_fixed_usd",
    starts_at: "2030-05-02T17:00:00Z",
    ends_at: "2030-05-02T17:45:00Z",
    starts_at_local: "2030-05-02T10:00:00",
    ends_at_local: "2030-05-02T10:45:00",
    schedule_timezone: "America/Los_Angeles",
    price: { amount_minor: 9500, currency: "USD", type: "fixed" }
  };
}
