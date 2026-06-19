import type {
  AdapterResult,
  AvailabilityFindInput,
  Booking,
  BookingAdapter,
  BookingCreateInput,
  BookingMandate,
  BookingStatusInput,
  Customer,
  Money,
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
// The synthetic target uses the core validator to behave like a conforming
// adapter. runConformance itself grades adapters black-box by returned
// AdapterResult problem codes.
import { validateMandate } from "@osbp/core";

async function confirmAndBook(adapter: BookingAdapter, input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
  // Transparent final-confirmation handshake: tolerate adapters that gate
  // booking.create behind an approval token, and pass through adapters that do
  // not, so the same check grades both.
  const first = await adapter.createBooking(input);
  if (first.ok || first.problem.code !== "requires_user_confirmation") {
    return first;
  }
  const token = first.problem.message.match(/approval\.token="([^"]+)"/)?.[1];
  if (!token) {
    return first;
  }
  return adapter.createBooking({ ...input, approval: { confirmed: true, token } });
}

async function approveInput(adapter: BookingAdapter, input: BookingCreateInput): Promise<BookingCreateInput> {
  const first = await adapter.createBooking(input);
  if (first.ok || first.problem.code !== "requires_user_confirmation") {
    return input;
  }
  const token = first.problem.message.match(/approval\.token="([^"]+)"/)?.[1];
  return token ? { ...input, approval: { confirmed: true, token } } : input;
}
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ConformanceCheckStatus = "pass" | "fail" | "skip";

export interface ConformanceCheck {
  id: string;
  requirement: string;
  spec_ref: string;
  status: ConformanceCheckStatus;
  detail?: string;
}

export interface ConformanceReport {
  passed: boolean;
  checks: ConformanceCheck[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
}

export type ConformanceScenarioMode = "normal" | "slot_taken" | "rate_limited";

export interface ConformanceFixtures {
  organization_id: string;
  schedule_id: string;
  provider_id: string;
  date: string;
  time: string;
  customer: Customer;
  services: {
    fixed_usd: string;
    fixed_eur: string;
    fixed_gbp: string;
    fixed_jpy: string;
    fixed_kwd: string;
    insurance_dependent: string;
    quote_required: string;
    consultation: string;
    deposit: string;
    full_prepay: string;
    unknown_payment: string;
    verification: string;
  };
  expected_prices: Record<string, { amount_minor: number; currency: string }>;
}

export interface ConformanceOptions {
  target_name?: string;
  fixtures?: PartialConformanceFixtures;
  schema_root?: string;
  create_scenario_adapter?: (mode: ConformanceScenarioMode) => BookingAdapter | Promise<BookingAdapter>;
}

export type PartialConformanceFixtures = Partial<Omit<ConformanceFixtures, "services" | "expected_prices">> & {
  services?: Partial<ConformanceFixtures["services"]>;
  expected_prices?: ConformanceFixtures["expected_prices"];
};

interface CheckContext {
  adapter: BookingAdapter;
  fixtures: ConformanceFixtures;
  schemas: PublishedSchemas;
  options: ConformanceOptions;
}

interface CheckOutcome {
  status: ConformanceCheckStatus;
  detail?: string;
}

interface CheckDefinition {
  id: string;
  requirement: string;
  spec_ref: string;
  run: (context: CheckContext) => Promise<CheckOutcome> | CheckOutcome;
}

type JsonRecord = Record<string, unknown>;
type JsonSchema = boolean | JsonRecord;

interface PublishedSchemas {
  registry: Record<string, JsonSchema>;
  loaded_from: string;
}

const SPEC_README = "docs/spec/v0.1.0/README.md";
const SPEC_SCHEMA = "docs/spec/v0.1.0/schema.md";
const BOOKING_STATUS_VALUES = ["booked", "cancelled", "completed", "no_show", "pending", "unknown"] as const;
const DEFAULT_SCHEMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../schemas/v0.1.0");

export const DEFAULT_CONFORMANCE_FIXTURES: ConformanceFixtures = {
  organization_id: "org_synthetic",
  schedule_id: "sched_main",
  provider_id: "prov_ada",
  date: "2030-05-02",
  time: "10:00",
  customer: {
    id: "cust_synthetic",
    phone: "+15555550100",
    email: "customer@example.com",
    display_name: "Synthetic Customer"
  },
  services: {
    fixed_usd: "svc_fixed_usd",
    fixed_eur: "svc_fixed_eur",
    fixed_gbp: "svc_fixed_gbp",
    fixed_jpy: "svc_fixed_jpy",
    fixed_kwd: "svc_fixed_kwd",
    insurance_dependent: "svc_insurance",
    quote_required: "svc_quote",
    consultation: "svc_consultation",
    deposit: "svc_deposit",
    full_prepay: "svc_full_prepay",
    unknown_payment: "svc_unknown_payment",
    verification: "svc_verification"
  },
  expected_prices: {
    svc_fixed_usd: { amount_minor: 9500, currency: "USD" },
    svc_fixed_eur: { amount_minor: 9000, currency: "EUR" },
    svc_fixed_gbp: { amount_minor: 8000, currency: "GBP" },
    svc_fixed_jpy: { amount_minor: 12000, currency: "JPY" },
    svc_fixed_kwd: { amount_minor: 12500, currency: "KWD" }
  }
};

export async function runConformance(
  adapter: BookingAdapter,
  options: ConformanceOptions = {}
): Promise<ConformanceReport> {
  const context: CheckContext = {
    adapter,
    fixtures: mergeFixtures(options.fixtures),
    schemas: loadPublishedSchemas(options.schema_root),
    options
  };

  const checks: ConformanceCheck[] = [];
  for (const definition of checkDefinitions) {
    try {
      const outcome = await definition.run(context);
      checks.push({ ...definition, status: outcome.status, detail: outcome.detail });
    } catch (error) {
      checks.push({
        ...definition,
        status: "fail",
        detail: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const summary = {
    total: checks.length,
    passed: checks.filter((check) => check.status === "pass").length,
    failed: checks.filter((check) => check.status === "fail").length,
    skipped: checks.filter((check) => check.status === "skip").length
  };

  return {
    passed: summary.failed === 0,
    checks,
    summary
  };
}

export function createSyntheticBookingAdapter(mode: ConformanceScenarioMode = "normal"): ConformanceSyntheticAdapter {
  return new ConformanceSyntheticAdapter({ mode });
}

export interface ConformanceSyntheticAdapterOptions {
  mode?: ConformanceScenarioMode;
}

interface SyntheticIdempotencyEntry {
  payload_hash: string;
  receipt: Receipt;
  booking: Booking;
}

export class ConformanceSyntheticAdapter implements BookingAdapter {
  readonly platform = { vendor: "osbp-synthetic", api_version: "v0.1.0" };
  private mode: ConformanceScenarioMode;
  private readonly idempotency = new Map<string, SyntheticIdempotencyEntry>();
  private readonly bookings = new Map<string, Booking>();
  private bookingCounter = 0;

  constructor(options: ConformanceSyntheticAdapterOptions = {}) {
    this.mode = options.mode ?? "normal";
  }

  setConformanceMode(mode: ConformanceScenarioMode): void {
    this.mode = mode;
  }

  resetConformanceState(): void {
    this.mode = "normal";
    this.idempotency.clear();
    this.bookings.clear();
    this.bookingCounter = 0;
  }

  async describeService(input: ServiceDescribeInput): Promise<AdapterResult<Service>> {
    const service = serviceById(input.service_id ?? DEFAULT_CONFORMANCE_FIXTURES.services.fixed_usd);
    return service ? ok(clone(service)) : problem("synthetic_service_not_found", "Synthetic service fixture not found");
  }

  async findAvailability(input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>> {
    const service = serviceById(input.service_id ?? DEFAULT_CONFORMANCE_FIXTURES.services.fixed_usd);
    if (!service) {
      return problem("synthetic_service_not_found", "Synthetic service fixture not found");
    }

    return ok([
      buildSyntheticSlot({
        service,
        schedule_id: input.schedule_id ?? DEFAULT_CONFORMANCE_FIXTURES.schedule_id,
        provider_id: input.provider_id ?? DEFAULT_CONFORMANCE_FIXTURES.provider_id,
        date: input.date
      })
    ]);
  }

  async explainPolicy(input: PolicyExplainInput): Promise<AdapterResult<Policy>> {
    const service = serviceById(input.service_id ?? DEFAULT_CONFORMANCE_FIXTURES.services.fixed_usd);
    return service ? ok(buildSyntheticPolicy(service)) : problem("synthetic_service_not_found", "Synthetic service fixture not found");
  }

  async sendVerification(input: VerificationSendInput): Promise<AdapterResult<VerificationChallenge>> {
    return ok({
      sent: true,
      method: input.customer?.email && !input.customer.phone ? "email" : "sms",
      purpose: input.purpose ?? `booking:${DEFAULT_CONFORMANCE_FIXTURES.organization_id}`
    });
  }

  async verifyCode(input: VerificationVerifyInput): Promise<AdapterResult<VerificationChallenge>> {
    if (input.code !== "123456") {
      return problem("verification_failed", "Synthetic verification code did not match");
    }

    return ok({
      verified: true,
      method: input.customer?.email && !input.customer.phone ? "email" : "sms",
      purpose: input.purpose ?? `booking:${DEFAULT_CONFORMANCE_FIXTURES.organization_id}`
    });
  }

  async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    const payloadHash = stableJson({ ...input, verification_code: undefined });
    const cached = this.idempotency.get(input.idempotency_key);
    if (cached) {
      return cached.payload_hash === payloadHash ? ok(clone(cached.receipt)) : problem(
        "idempotency_conflict",
        "idempotency_key was reused with a different booking payload"
      );
    }

    if (this.mode === "slot_taken") {
      return problem("slot_taken", "Synthetic slot is no longer available", true);
    }
    if (this.mode === "rate_limited") {
      return problem("rate_limited", "Synthetic upstream rate limit reached", true);
    }

    const service = serviceById(input.service_id);
    if (!service) {
      return problem("synthetic_service_not_found", "Synthetic service fixture not found");
    }
    const policy = buildSyntheticPolicy(service);
    const slot = buildSyntheticSlot({
      service,
      schedule_id: input.schedule_id,
      provider_id: input.provider_id,
      date: input.date,
      time: input.time
    });

    const validation = validateMandate({
      mandate: input.mandate,
      action: "booking.create",
      organization_id: DEFAULT_CONFORMANCE_FIXTURES.organization_id,
      service,
      slot,
      policy
    });
    if (!validation.ok) {
      return { ok: false, problem: validation.problem };
    }

    if (policy.verification_method !== "none" && !input.verification_code) {
      return problem("requires_verification", "Synthetic customer verification required before booking", true);
    }
    if (input.verification_code !== undefined && input.verification_code !== "123456") {
      return problem("verification_failed", "Synthetic verification code did not match");
    }

    this.bookingCounter += 1;
    const bookingId = `booking_${this.bookingCounter}`;
    const booking: Booking = {
      id: bookingId,
      status: "booked",
      service_id: service.id,
      schedule_id: input.schedule_id,
      provider_id: input.provider_id,
      starts_at: slot.starts_at,
      starts_at_local: slot.starts_at_local,
      schedule_timezone: slot.schedule_timezone,
      customer_id: input.customer?.id
    };
    const receipt: Receipt = {
      id: `receipt_${input.idempotency_key}`,
      booking_id: bookingId,
      text: `Booked ${service.name} on ${input.date} at ${input.time}. Synthetic booking id: ${bookingId}.`
    };

    this.bookings.set(bookingId, booking);
    this.idempotency.set(input.idempotency_key, {
      payload_hash: payloadHash,
      receipt,
      booking
    });

    return ok(clone(receipt));
  }

  async getBooking(input: BookingStatusInput): Promise<AdapterResult<Booking>> {
    const booking = input.booking_id ? this.bookings.get(input.booking_id) : undefined;
    return booking ? ok(clone(booking)) : problem("booking_not_found", "Synthetic booking not found");
  }
}

const checkDefinitions: CheckDefinition[] = [
  {
    id: "schema.result_envelope.success",
    requirement: "Successful adapter results match the published OSBP result envelope schema.",
    spec_ref: `${SPEC_SCHEMA}#result-envelope`,
    run: async (context) => {
      const result = await callAdapter(() => context.adapter.describeService({ service_id: context.fixtures.services.fixed_usd }));
      return result.kind === "throw" ? fail(`adapter threw: ${describeThrown(result.threw)}`) : validateResultSchema(context, result.result);
    }
  },
  {
    id: "schema.problem.failure",
    requirement: "Failure adapter results and Problem payloads match the published schemas.",
    spec_ref: `${SPEC_SCHEMA}#problem`,
    run: async (context) => {
      const result = await callAdapter(() => context.adapter.createBooking(buildCreateInput(context.fixtures, {
        idempotency_key: "schema_problem_failure",
        mandate: { expires_at: "2030-05-01T13:00:00" }
      })));
      if (result.kind === "throw") {
        return fail(`adapter threw: ${describeThrown(result.threw)}`);
      }
      const envelope = validateResultSchema(context, result.result);
      if (envelope.status !== "pass") {
        return envelope;
      }
      return result.result.ok ? fail("expected a failed AdapterResult") : validateProblemSchema(context, result.result.problem);
    }
  },
  {
    id: "schema.booking_mandate.fixture",
    requirement: "BookingMandate payloads used for mutations match the published mandate JSON Schema.",
    spec_ref: `${SPEC_SCHEMA}#bookingmandate`,
    run: (context) => validateSchemaCheck(context, "booking-mandate.schema.json", buildMandate(context.fixtures), "BookingMandate")
  },
  {
    id: "schema.tool_inputs.booking_create",
    requirement: "booking.create inputs generated by the kit match the published tool-input schema.",
    spec_ref: `${SPEC_SCHEMA}#tool-inputs`,
    run: (context) => validateSchemaCheck(
      context,
      "tool-inputs.schema.json#/$defs/osbp_booking_create",
      buildCreateInput(context.fixtures, { idempotency_key: "schema_tool_input" }),
      "booking.create input"
    )
  },
  {
    id: "adapter.failure_result_no_throw",
    requirement: "Adapter failures are returned as AdapterResult values instead of thrown exceptions.",
    spec_ref: `${SPEC_SCHEMA}#adapter-interface`,
    run: async (context) => {
      const result = await callAdapter(() => context.adapter.createBooking(buildCreateInput(context.fixtures, {
        idempotency_key: "no_throw_invalid_mandate",
        mandate: { expires_at: "2030-05-01T13:00:00" }
      })));
      if (result.kind === "throw") {
        return fail(`adapter threw instead of returning a Problem: ${describeThrown(result.threw)}`);
      }
      return pass();
    }
  },
  {
    id: "shape.service.duration_iso8601",
    requirement: "Service.duration is an ISO 8601 duration string, not a minute count.",
    spec_ref: `${SPEC_SCHEMA}#core-objects`,
    run: async (context) => {
      const service = await requireService(context, context.fixtures.services.fixed_usd);
      return service.status !== "pass" ? service : requireDuration("Service.duration", service.value.duration);
    }
  },
  {
    id: "shape.service.option_duration_iso8601",
    requirement: "ServiceOption.duration is an ISO 8601 duration string when options are present.",
    spec_ref: `${SPEC_SCHEMA}#core-objects`,
    run: async (context) => {
      const service = await requireService(context, context.fixtures.services.fixed_usd);
      if (service.status !== "pass") {
        return service;
      }
      const option = service.value.options?.find((candidate) => candidate.duration !== undefined);
      return option ? requireDuration("ServiceOption.duration", option.duration) : skip("service has no duration-bearing options");
    }
  },
  {
    id: "shape.money.fixed_minor_units",
    requirement: "Fixed Money values carry integer amount_minor plus ISO 4217 currency.",
    spec_ref: `${SPEC_SCHEMA}#money`,
    run: async (context) => requireExpectedServiceMoney(context, context.fixtures.services.fixed_usd)
  },
  {
    id: "shape.money.jpy_minor_units",
    requirement: "JPY fixed Money uses the currency's zero-decimal minor-unit exponent, not cents.",
    spec_ref: `${SPEC_SCHEMA}#money`,
    run: async (context) => requireExpectedServiceMoney(context, context.fixtures.services.fixed_jpy)
  },
  {
    id: "shape.money.kwd_minor_units",
    requirement: "KWD fixed Money uses the currency's three-decimal minor-unit exponent, not cents.",
    spec_ref: `${SPEC_SCHEMA}#money`,
    run: async (context) => requireExpectedServiceMoney(context, context.fixtures.services.fixed_kwd)
  },
  {
    id: "shape.money.non_fixed_absent_amount",
    requirement: "Non-fixed Money types omit amount_minor so mandate caps fail closed.",
    spec_ref: `${SPEC_SCHEMA}#money`,
    run: async (context) => {
      const insurance = await requireService(context, context.fixtures.services.insurance_dependent);
      if (insurance.status !== "pass") {
        return insurance;
      }
      const quote = await requireService(context, context.fixtures.services.quote_required);
      if (quote.status !== "pass") {
        return quote;
      }
      const failures = [
        ...requireNonFixedMoney("insurance_dependent service price", insurance.value.price, "insurance_dependent"),
        ...requireNonFixedMoney("quote_required service price", quote.value.price, "quote_required")
      ];
      return failures.length === 0 ? pass() : fail(failures.join("; "));
    }
  },
  {
    id: "shape.operating_hours.iso_weekday",
    requirement: "OperatingHours.day uses ISO 8601 weekdays 1 through 7 and wall-clock HH:MM hours.",
    spec_ref: `${SPEC_SCHEMA}#time-discipline`,
    run: async (context) => {
      const slot = await requireFirstSlot(context);
      if (slot.status !== "pass") {
        return slot;
      }
      const failures: string[] = [];
      for (const [index, hours] of (slot.value.schedule_hours ?? []).entries()) {
        if (!Number.isInteger(hours.day) || hours.day < 1 || hours.day > 7) {
          failures.push(`Slot.schedule_hours[${index}].day expected 1..7, got ${describeValue(hours.day)}`);
        }
        requireWallClockTime(failures, `Slot.schedule_hours[${index}].open`, hours.open);
        requireWallClockTime(failures, `Slot.schedule_hours[${index}].close`, hours.close);
      }
      return failures.length === 0 ? pass() : fail(failures.join("; "));
    }
  },
  {
    id: "shape.slot.time_pair",
    requirement: "Slot carries an offset-bearing instant, merchant-local wall-clock time, and schedule_timezone together.",
    spec_ref: `${SPEC_SCHEMA}#time-discipline`,
    run: async (context) => {
      const slot = await requireFirstSlot(context);
      if (slot.status !== "pass") {
        return slot;
      }
      const failures: string[] = [];
      requireInstant(failures, "Slot.starts_at", slot.value.starts_at);
      requireWallClockDateTime(failures, "Slot.starts_at_local", slot.value.starts_at_local);
      requireNonEmptyString(failures, "Slot.schedule_timezone", slot.value.schedule_timezone);
      return failures.length === 0 ? pass() : fail(failures.join("; "));
    }
  },
  {
    id: "shape.slot.denormalized_context",
    requirement: "Slot carries denormalized organization, schedule, provider, and location context for presentation without round-trips.",
    spec_ref: `${SPEC_SCHEMA}#core-objects`,
    run: async (context) => {
      const slot = await requireFirstSlot(context);
      if (slot.status !== "pass") {
        return slot;
      }
      const failures: string[] = [];
      requireNonEmptyString(failures, "Slot.organization_id", slot.value.organization_id);
      requireNonEmptyString(failures, "Slot.schedule_name", slot.value.schedule_name);
      requireFiniteNumber(failures, "Slot.schedule_latitude", slot.value.schedule_latitude);
      requireFiniteNumber(failures, "Slot.schedule_longitude", slot.value.schedule_longitude);
      requireNonEmptyString(failures, "Slot.provider_name", slot.value.provider_name);
      requireNonEmptyString(failures, "Slot.organization_name", slot.value.organization_name);
      return failures.length === 0 ? pass() : fail(failures.join("; "));
    }
  },
  {
    id: "shape.booking.status_enum",
    requirement: "Booking.status is one of booked, cancelled, completed, no_show, pending, unknown.",
    spec_ref: `${SPEC_SCHEMA}#core-objects`,
    run: async (context) => {
      const booking = await createAndReadBooking(context, "shape_booking_status");
      if (booking.status !== "pass") {
        return booking;
      }
      return BOOKING_STATUS_VALUES.includes(booking.value.status as typeof BOOKING_STATUS_VALUES[number])
        ? pass()
        : fail(`Booking.status expected enum value, got ${describeValue(booking.value.status)}`);
    }
  },
  {
    id: "shape.ids.organization_booking",
    requirement: "Domain ids use organization_id and booking_id fields, not camelCase or generic aliases.",
    spec_ref: `${SPEC_SCHEMA}#core-objects`,
    run: async (context) => {
      const slot = await requireFirstSlot(context);
      if (slot.status !== "pass") {
        return slot;
      }
      const receipt = await createReceipt(context, "shape_ids");
      if (receipt.status !== "pass") {
        return receipt;
      }
      const failures: string[] = [];
      requireNonEmptyString(failures, "Slot.organization_id", slot.value.organization_id);
      requireNonEmptyString(failures, "Receipt.booking_id", receipt.value.booking_id);
      if ("organizationId" in (slot.value as unknown as JsonRecord)) {
        failures.push("Slot must not expose organizationId");
      }
      if ("bookingId" in (receipt.value as unknown as JsonRecord)) {
        failures.push("Receipt must not expose bookingId");
      }
      return failures.length === 0 ? pass() : fail(failures.join("; "));
    }
  },
  {
    id: "time.instants_have_offsets",
    requirement: "Instant fields carry Z or an explicit UTC offset.",
    spec_ref: `${SPEC_SCHEMA}#time-discipline`,
    run: async (context) => {
      const slot = await requireFirstSlot(context);
      if (slot.status !== "pass") {
        return slot;
      }
      const booking = await createAndReadBooking(context, "time_instants");
      if (booking.status !== "pass") {
        return booking;
      }
      const failures: string[] = [];
      requireInstant(failures, "Slot.starts_at", slot.value.starts_at);
      requireInstant(failures, "Slot.ends_at", slot.value.ends_at);
      requireInstant(failures, "Booking.starts_at", booking.value.starts_at);
      return failures.length === 0 ? pass() : fail(failures.join("; "));
    }
  },
  {
    id: "time.wall_clock_no_offsets",
    requirement: "Wall-clock fields do not carry Z or UTC offsets.",
    spec_ref: `${SPEC_SCHEMA}#time-discipline`,
    run: async (context) => {
      const slot = await requireFirstSlot(context);
      if (slot.status !== "pass") {
        return slot;
      }
      const booking = await createAndReadBooking(context, "time_wall_clock");
      if (booking.status !== "pass") {
        return booking;
      }
      const failures: string[] = [];
      requireWallClockDateTime(failures, "Slot.starts_at_local", slot.value.starts_at_local);
      requireWallClockDateTime(failures, "Slot.ends_at_local", slot.value.ends_at_local);
      requireWallClockDateTime(failures, "Booking.starts_at_local", booking.value.starts_at_local);
      return failures.length === 0 ? pass() : fail(failures.join("; "));
    }
  },
  problemCheck("mandate.mandate_expired", "mandate_expired", "Expired mandates fail closed.", { mandate: { expires_at: "2000-01-01T00:00:00Z" } }),
  problemCheck("mandate.invalid_mandate.expires_at", "invalid_mandate", "Naked expires_at values fail as invalid_mandate.", { mandate: { expires_at: "2030-05-01T13:00:00" } }),
  problemCheck("mandate.invalid_mandate.wall_clock_offset", "invalid_mandate", "Offset-carrying wall-clock mandate fields fail as invalid_mandate.", { mandate: { earliest_start: "2030-05-02T09:00:00Z" } }),
  problemCheck("mandate.action_not_allowed", "action_not_allowed", "booking.create must be included in allowed_actions.", { mandate: { allowed_actions: ["service.describe"] } }),
  problemCheck("mandate.organization_not_allowed", "organization_not_allowed", "Selected organization must be inside mandate scope.", { mandate: { organization_id: "org_other" } }),
  problemCheck("mandate.service_not_allowed", "service_not_allowed", "Selected service must be inside mandate scope.", { mandate: { service_ids: ["svc_other"] } }),
  problemCheck("mandate.schedule_not_allowed", "schedule_not_allowed", "Selected schedule must be inside mandate scope.", { mandate: { schedule_ids: ["sched_other"] } }),
  problemCheck("mandate.provider_unknown", "provider_unknown", "Provider-scoped mandates fail closed when the slot has no provider id.", { input: { provider_id: "" } }),
  problemCheck("mandate.provider_not_allowed", "provider_not_allowed", "Selected provider must be inside mandate scope.", { input: { provider_id: "prov_other" } }),
  problemCheck("mandate.slot_too_early", "slot_too_early", "Selected slot cannot start before mandate.earliest_start.", { mandate: { earliest_start: "2030-05-02T11:00:00" } }),
  problemCheck("mandate.slot_too_late", "slot_too_late", "Selected slot cannot end after mandate.latest_end.", { mandate: { latest_end: "2030-05-02T10:30:00" } }),
  problemCheck("mandate.price_exceeds_mandate", "price_exceeds_mandate", "Selected fixed price cannot exceed mandate.max_price.", { mandate: { max_price: { amount_minor: 1, currency: "USD" } } }),
  problemCheck("mandate.currency_mismatch.eur", "currency_mismatch", "EUR selected prices fail closed against a USD mandate cap.", {
    service_key: "fixed_eur",
    mandate: { max_price: { amount_minor: 20000, currency: "USD" } }
  }),
  problemCheck("mandate.currency_mismatch.gbp", "currency_mismatch", "GBP selected prices fail closed against a USD mandate cap.", {
    service_key: "fixed_gbp",
    mandate: { max_price: { amount_minor: 20000, currency: "USD" } }
  }),
  problemCheck("mandate.requires_user_confirmation.unknown_payment", "requires_user_confirmation", "Unknown payment requirements fail closed before mutation.", { service_key: "unknown_payment" }),
  problemCheck("mandate.requires_user_confirmation.insurance_dependent", "requires_user_confirmation", "Insurance-dependent prices without fixed amount_minor require user confirmation.", { service_key: "insurance_dependent" }),
  problemCheck("mandate.requires_user_confirmation.quote_required", "requires_user_confirmation", "Quote-required prices without fixed amount_minor require user confirmation.", { service_key: "quote_required" }),
  problemCheck("mandate.requires_payment_handoff.deposit", "requires_payment_handoff", "Deposit requirements route to payment handoff in v0.1.0.", { service_key: "deposit" }),
  problemCheck("mandate.requires_payment_handoff.full_prepay", "requires_payment_handoff", "Full prepayment requirements route to payment handoff in v0.1.0.", { service_key: "full_prepay" }),
  problemCheck("mandate.requires_consultation_handoff", "requires_consultation_handoff", "Consultation or quote workflows route to handoff instead of booking.", { service_key: "consultation" }),
  {
    id: "idempotency.replay_same_payload",
    requirement: "The same idempotency_key with the same payload replays the same receipt.",
    spec_ref: `${SPEC_README}#bookingcreate`,
    run: async (context) => {
      const input = buildCreateInput(context.fixtures, { idempotency_key: "idempotency_replay" });
      const first = await callAdapter(() => confirmAndBook(context.adapter, input));
      const second = await callAdapter(() => context.adapter.createBooking(input));
      if (first.kind === "throw" || second.kind === "throw") {
        return fail(`adapter threw during replay check: ${describeThrown(first.kind === "throw" ? first.threw : second.kind === "throw" ? second.threw : undefined)}`);
      }
      if (!first.result.ok || !second.result.ok) {
        return fail(`expected two successful receipts, got ${summarizeResult(first.result)} then ${summarizeResult(second.result)}`);
      }
      return first.result.value.id === second.result.value.id &&
        first.result.value.booking_id === second.result.value.booking_id
        ? pass()
        : fail("same idempotency_key and payload returned different receipts");
    }
  },
  {
    id: "idempotency.conflict_different_payload",
    requirement: "The same idempotency_key with a different payload returns idempotency_conflict.",
    spec_ref: `${SPEC_README}#bookingcreate`,
    run: async (context) => {
      const firstInput = buildCreateInput(context.fixtures, { idempotency_key: "idempotency_conflict" });
      const secondInput = buildCreateInput(context.fixtures, {
        idempotency_key: "idempotency_conflict",
        input: { time: "11:00" }
      });
      const first = await callAdapter(() => confirmAndBook(context.adapter, firstInput));
      if (first.kind === "throw" || !first.result.ok) {
        return fail(`expected first create to succeed, got ${first.kind === "throw" ? describeThrown(first.threw) : summarizeResult(first.result)}`);
      }
      return expectProblem(context, () => context.adapter.createBooking(secondInput), "idempotency_conflict");
    }
  },
  {
    id: "verification.required_then_code_books",
    requirement: "Verification-required booking returns requires_verification, sends a code, then books when retried with the code.",
    spec_ref: `${SPEC_README}#canonical-flow`,
    run: async (context) => {
      const input = buildCreateInput(context.fixtures, {
        idempotency_key: "verification_required",
        service_key: "verification"
      });
      const approved = await approveInput(context.adapter, input);
      const initial = await expectProblem(context, () => context.adapter.createBooking(approved), "requires_verification");
      if (initial.status !== "pass") {
        return initial;
      }
      const sent = await callAdapter(() => context.adapter.sendVerification({
        customer: context.fixtures.customer,
        purpose: `booking:${context.fixtures.organization_id}`
      }));
      if (sent.kind === "throw" || !sent.result.ok || sent.result.value.sent !== true) {
        return fail(`verification.send did not return a sent challenge: ${sent.kind === "throw" ? describeThrown(sent.threw) : summarizeResult(sent.result)}`);
      }
      const booked = await callAdapter(() => context.adapter.createBooking({
        ...approved,
        verification_code: "123456"
      }));
      if (booked.kind === "throw" || !booked.result.ok) {
        return fail(`retry with verification_code did not book: ${booked.kind === "throw" ? describeThrown(booked.threw) : summarizeResult(booked.result)}`);
      }
      return requireReadableReceipt(booked.result.value);
    }
  },
  {
    id: "runtime.slot_taken",
    requirement: "A disappeared slot returns retryable slot_taken instead of an ambiguous failure.",
    spec_ref: `${SPEC_SCHEMA}#problem`,
    run: async (context) => runControlledProblem(context, "slot_taken", "slot_taken", "runtime_slot_taken")
  },
  {
    id: "runtime.rate_limited",
    requirement: "Upstream rate limits return retryable rate_limited.",
    spec_ref: `${SPEC_SCHEMA}#problem`,
    run: async (context) => runControlledProblem(context, "rate_limited", "rate_limited", "runtime_rate_limited")
  },
  {
    id: "happy_path.create_status_receipt",
    requirement: "A fixed-price, no-payment, non-consultation service can create a booking, read status, and return a human-readable receipt.",
    spec_ref: `${SPEC_README}#canonical-flow`,
    run: async (context) => {
      const receipt = await createReceipt(context, "happy_path");
      if (receipt.status !== "pass") {
        return receipt;
      }
      const receiptShape = requireReadableReceipt(receipt.value);
      if (receiptShape.status !== "pass") {
        return receiptShape;
      }
      const booking = await callAdapter(() => context.adapter.getBooking({
        booking_id: receipt.value.booking_id,
        customer: context.fixtures.customer
      }));
      if (booking.kind === "throw" || !booking.result.ok) {
        return fail(`booking.status did not return the created booking: ${booking.kind === "throw" ? describeThrown(booking.threw) : summarizeResult(booking.result)}`);
      }
      return pass();
    }
  }
];

interface ProblemCheckConfig {
  service_key?: keyof ConformanceFixtures["services"];
  mandate?: Partial<BookingMandate>;
  input?: Partial<BookingCreateInput>;
}

function problemCheck(
  id: string,
  expectedCode: string,
  requirement: string,
  config: ProblemCheckConfig
): CheckDefinition {
  return {
    id,
    requirement,
    spec_ref: `${SPEC_README}#server-obligations`,
    run: async (context) => expectProblem(
      context,
      () => context.adapter.createBooking(buildCreateInput(context.fixtures, {
        idempotency_key: id.replaceAll(".", "_"),
        service_key: config.service_key,
        mandate: config.mandate,
        input: config.input
      })),
      expectedCode
    )
  };
}

async function runControlledProblem(
  context: CheckContext,
  mode: ConformanceScenarioMode,
  expectedCode: string,
  idempotencyKey: string
): Promise<CheckOutcome> {
  const controlledAdapter = await getControlledAdapter(context, mode);
  if (!controlledAdapter) {
    return skip("target did not provide a controlled conformance scenario adapter");
  }

  try {
    return await expectProblem(
      { ...context, adapter: controlledAdapter },
      () => confirmAndBook(controlledAdapter, buildCreateInput(context.fixtures, { idempotency_key: idempotencyKey })),
      expectedCode
    );
  } finally {
    resetControlledAdapter(controlledAdapter);
  }
}

async function getControlledAdapter(
  context: CheckContext,
  mode: ConformanceScenarioMode
): Promise<BookingAdapter | undefined> {
  if (context.options.create_scenario_adapter) {
    return context.options.create_scenario_adapter(mode);
  }

  const maybeControlled = context.adapter as BookingAdapter & {
    setConformanceMode?: (mode: ConformanceScenarioMode) => void;
  };
  if (typeof maybeControlled.setConformanceMode === "function") {
    maybeControlled.setConformanceMode(mode);
    return maybeControlled;
  }

  return undefined;
}

function resetControlledAdapter(adapter: BookingAdapter): void {
  const maybeControlled = adapter as BookingAdapter & {
    setConformanceMode?: (mode: ConformanceScenarioMode) => void;
  };
  maybeControlled.setConformanceMode?.("normal");
}

async function expectProblem<T>(
  context: CheckContext,
  operation: () => Promise<AdapterResult<T>>,
  expectedCode: string
): Promise<CheckOutcome> {
  const result = await callAdapter(operation);
  if (result.kind === "throw") {
    return fail(`adapter threw: ${describeThrown(result.threw)}`);
  }
  const envelope = validateResultSchema(context, result.result);
  if (envelope.status !== "pass") {
    return envelope;
  }
  if (result.result.ok) {
    return fail(`expected Problem ${expectedCode}, got success`);
  }
  const problemShape = validateProblemSchema(context, result.result.problem);
  if (problemShape.status !== "pass") {
    return problemShape;
  }
  return result.result.problem.code === expectedCode
    ? pass()
    : fail(`expected Problem ${expectedCode}, got ${result.result.problem.code}`);
}

async function createReceipt(context: CheckContext, idempotencyKey: string): Promise<CheckOutcome & { value: Receipt }> {
  const result = await callAdapter(() => confirmAndBook(context.adapter, buildCreateInput(context.fixtures, {
    idempotency_key: idempotencyKey
  })));
  if (result.kind === "throw") {
    return valueFail(`adapter threw: ${describeThrown(result.threw)}`);
  }
  if (!result.result.ok) {
    return valueFail(`expected successful receipt, got ${summarizeResult(result.result)}`);
  }
  return { ...pass(), value: result.result.value };
}

async function createAndReadBooking(context: CheckContext, idempotencyKey: string): Promise<CheckOutcome & { value: Booking }> {
  const receipt = await createReceipt(context, idempotencyKey);
  if (receipt.status !== "pass") {
    return valueFail(receipt.detail ?? "create failed");
  }
  const booking = await callAdapter(() => context.adapter.getBooking({
    booking_id: receipt.value.booking_id,
    customer: context.fixtures.customer
  }));
  if (booking.kind === "throw") {
    return valueFail(`adapter threw: ${describeThrown(booking.threw)}`);
  }
  return booking.result.ok
    ? { ...pass(), value: booking.result.value }
    : valueFail(`expected booking.status success, got ${summarizeResult(booking.result)}`);
}

async function requireService(context: CheckContext, serviceId: string): Promise<CheckOutcome & { value: Service }> {
  const result = await callAdapter(() => context.adapter.describeService({ service_id: serviceId }));
  if (result.kind === "throw") {
    return valueFail(`adapter threw: ${describeThrown(result.threw)}`);
  }
  return result.result.ok
    ? { ...pass(), value: result.result.value }
    : valueFail(`describeService(${serviceId}) failed: ${summarizeResult(result.result)}`);
}

async function requireFirstSlot(context: CheckContext): Promise<CheckOutcome & { value: Slot }> {
  const result = await callAdapter(() => context.adapter.findAvailability({
    service_id: context.fixtures.services.fixed_usd,
    schedule_id: context.fixtures.schedule_id,
    date: context.fixtures.date,
    provider_id: context.fixtures.provider_id
  }));
  if (result.kind === "throw") {
    return valueFail(`adapter threw: ${describeThrown(result.threw)}`);
  }
  if (!result.result.ok) {
    return valueFail(`findAvailability failed: ${summarizeResult(result.result)}`);
  }
  const slot = result.result.value[0];
  return slot ? { ...pass(), value: slot } : valueFail("findAvailability returned no slots");
}

async function requireExpectedServiceMoney(context: CheckContext, serviceId: string): Promise<CheckOutcome> {
  const expected = context.fixtures.expected_prices[serviceId];
  if (!expected) {
    return skip(`no expected price fixture for ${serviceId}`);
  }
  const service = await requireService(context, serviceId);
  if (service.status !== "pass") {
    return service;
  }
  const failures = requireFixedMoney(`Service(${serviceId}).price`, service.value.price, expected);
  return failures.length === 0 ? pass() : fail(failures.join("; "));
}

function requireReadableReceipt(receipt: Receipt): CheckOutcome {
  const failures: string[] = [];
  requireNonEmptyString(failures, "Receipt.id", receipt.id);
  requireNonEmptyString(failures, "Receipt.booking_id", receipt.booking_id);
  requireNonEmptyString(failures, "Receipt.text", receipt.text);
  if (receipt.text && receipt.text.length < 24) {
    failures.push("Receipt.text should be human-readable, got a very short string");
  }
  return failures.length === 0 ? pass() : fail(failures.join("; "));
}

function buildCreateInput(
  fixtures: ConformanceFixtures,
  overrides: {
    idempotency_key: string;
    service_key?: keyof ConformanceFixtures["services"];
    mandate?: Partial<BookingMandate>;
    input?: Partial<BookingCreateInput>;
  }
): BookingCreateInput {
  const serviceId = overrides.service_key ? fixtures.services[overrides.service_key] : fixtures.services.fixed_usd;
  const base: BookingCreateInput = {
    mandate: buildMandate(fixtures, {
      service_id: serviceId,
      price: fixturePriceForService(fixtures, serviceId),
      overrides: overrides.mandate
    }),
    idempotency_key: overrides.idempotency_key,
    service_id: serviceId,
    schedule_id: fixtures.schedule_id,
    provider_id: fixtures.provider_id,
    date: fixtures.date,
    time: fixtures.time,
    customer: fixtures.customer
  };

  return {
    ...base,
    ...overrides.input,
    mandate: {
      ...base.mandate,
      ...overrides.input?.mandate
    }
  };
}

function buildMandate(
  fixtures: ConformanceFixtures,
  input: {
    service_id?: string;
    price?: Money;
    overrides?: Partial<BookingMandate>;
  } = {}
): BookingMandate {
  const price = input.price ?? fixturePriceForService(fixtures, input.service_id ?? fixtures.services.fixed_usd);
  const currency = price?.currency ?? "USD";
  const amount = price?.amount_minor ?? 20000;
  return {
    id: "mnd_conformance",
    expires_at: "2030-05-01T13:00:00Z",
    allowed_actions: ["booking.create"],
    organization_id: fixtures.organization_id,
    service_ids: [input.service_id ?? fixtures.services.fixed_usd],
    provider_ids: [fixtures.provider_id],
    schedule_ids: [fixtures.schedule_id],
    earliest_start: `${fixtures.date}T09:00:00`,
    latest_end: `${fixtures.date}T12:00:00`,
    max_price: {
      amount_minor: amount,
      currency
    },
    allow_policy_fee: false,
    max_extra_fee: {
      amount_minor: 0,
      currency
    },
    ...input.overrides
  };
}

function fixturePriceForService(fixtures: ConformanceFixtures, serviceId: string): Money | undefined {
  const expected = fixtures.expected_prices[serviceId];
  return expected ? { amount_minor: expected.amount_minor, currency: expected.currency, type: "fixed" } : { amount_minor: 20000, currency: "USD" };
}

async function callAdapter<T>(
  operation: () => Promise<AdapterResult<T>>
): Promise<{ kind: "result"; result: AdapterResult<T> } | { kind: "throw"; threw: unknown }> {
  try {
    return { kind: "result", result: await operation() };
  } catch (error) {
    return { kind: "throw", threw: error };
  }
}

function validateResultSchema(context: CheckContext, value: unknown): CheckOutcome {
  return validateSchemaCheck(context, "result-envelope.schema.json", value, "AdapterResult");
}

function validateProblemSchema(context: CheckContext, value: unknown): CheckOutcome {
  return validateSchemaCheck(context, "problem.schema.json", value, "Problem");
}

function validateSchemaCheck(context: CheckContext, schemaRef: string, value: unknown, label: string): CheckOutcome {
  const [schemaName, pointer] = schemaRef.split("#");
  const rootSchema = context.schemas.registry[schemaName];
  if (!rootSchema) {
    return fail(`published schema ${schemaName} not loaded from ${context.schemas.loaded_from}`);
  }
  const schema = pointer ? resolveJsonPointer(rootSchema, pointer) : rootSchema;
  if (!schema) {
    return fail(`published schema pointer ${schemaRef} was not found`);
  }
  const failures = validateJsonSchema(schema, value, context.schemas.registry, label);
  return failures.length === 0 ? pass() : fail(failures.join("; "));
}

function loadPublishedSchemas(schemaRoot = DEFAULT_SCHEMA_ROOT): PublishedSchemas {
  const registry: Record<string, JsonSchema> = {};
  for (const name of [
    "booking-mandate.schema.json",
    "problem.schema.json",
    "result-envelope.schema.json",
    "tool-inputs.schema.json"
  ]) {
    registry[name] = JSON.parse(readFileSync(join(schemaRoot, name), "utf8")) as JsonSchema;
  }

  return {
    registry,
    loaded_from: schemaRoot
  };
}

function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  registry: Record<string, JsonSchema>,
  path: string
): string[] {
  if (schema === true) {
    return [];
  }
  if (schema === false) {
    return [`${path} is not allowed by schema`];
  }

  if (typeof schema.$ref === "string") {
    const refSchema = registry[schema.$ref];
    if (!refSchema) {
      return [`${path} references unknown schema ${schema.$ref}`];
    }
    return validateJsonSchema(refSchema, value, registry, path);
  }

  if (Array.isArray(schema.oneOf)) {
    const branchFailures = schema.oneOf.map((branch, index) => ({
      index,
      failures: validateJsonSchema(branch as JsonSchema, value, registry, path)
    }));
    const passing = branchFailures.filter((branch) => branch.failures.length === 0);
    if (passing.length === 1) {
      return [];
    }
    return [`${path} expected exactly one schema branch to match, matched ${passing.length}`];
  }

  if ("const" in schema && value !== schema.const) {
    return [`${path} expected const ${describeValue(schema.const)}, got ${describeValue(value)}`];
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [`${path} expected one of ${schema.enum.map(describeValue).join("|")}, got ${describeValue(value)}`];
  }

  const failures: string[] = [];
  if (schema.type === "object") {
    if (!isRecord(value)) {
      return [`${path} expected object, got ${describeValue(value)}`];
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof required === "string" && !hasOwn(value, required)) {
        failures.push(`${path}.${required} is required`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (hasOwn(value, key)) {
        failures.push(...validateJsonSchema(propertySchema as JsonSchema, value[key], registry, `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(properties, key)) {
          failures.push(`${path}.${key} is not allowed`);
        }
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      return [`${path} expected array, got ${describeValue(value)}`];
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        failures.push(...validateJsonSchema(schema.items as JsonSchema, item, registry, `${path}[${index}]`));
      });
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      failures.push(`${path} expected string, got ${describeValue(value)}`);
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") {
      failures.push(`${path} expected boolean, got ${describeValue(value)}`);
    }
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      failures.push(`${path} expected ${schema.type}, got ${describeValue(value)}`);
    } else if (schema.type === "integer" && !Number.isInteger(value)) {
      failures.push(`${path} expected integer, got ${describeValue(value)}`);
    } else {
      if (typeof schema.minimum === "number" && value < schema.minimum) {
        failures.push(`${path} expected >= ${schema.minimum}, got ${value}`);
      }
      if (typeof schema.maximum === "number" && value > schema.maximum) {
        failures.push(`${path} expected <= ${schema.maximum}, got ${value}`);
      }
    }
  }

  return failures;
}

function resolveJsonPointer(schema: JsonSchema, pointer: string): JsonSchema | undefined {
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  let current: unknown = schema;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "boolean" || isRecord(current) ? current : undefined;
}

function mergeFixtures(overrides: PartialConformanceFixtures = {}): ConformanceFixtures {
  return {
    ...DEFAULT_CONFORMANCE_FIXTURES,
    ...overrides,
    customer: {
      ...DEFAULT_CONFORMANCE_FIXTURES.customer,
      ...overrides.customer
    },
    services: {
      ...DEFAULT_CONFORMANCE_FIXTURES.services,
      ...overrides.services
    },
    expected_prices: {
      ...DEFAULT_CONFORMANCE_FIXTURES.expected_prices,
      ...overrides.expected_prices
    }
  };
}

function pass(): CheckOutcome {
  return { status: "pass" };
}

function fail(detail: string): CheckOutcome {
  return { status: "fail", detail };
}

function skip(detail: string): CheckOutcome {
  return { status: "skip", detail };
}

function valueFail<T>(detail: string): CheckOutcome & { value: T } {
  return { status: "fail", detail, value: undefined as T };
}

function requireDuration(path: string, value: unknown): CheckOutcome {
  return typeof value === "string" && /^P(?=\d|T\d)(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/.test(value)
    ? pass()
    : fail(`${path} expected ISO 8601 duration string, got ${describeValue(value)}`);
}

function requireFixedMoney(
  path: string,
  value: Money | undefined,
  expected: { amount_minor: number; currency: string }
): string[] {
  const failures: string[] = [];
  if (!isRecord(value)) {
    return [`${path} expected Money object, got ${describeValue(value)}`];
  }
  if (!Number.isInteger(value.amount_minor) || value.amount_minor !== expected.amount_minor) {
    failures.push(`${path}.amount_minor expected ${expected.amount_minor}, got ${describeValue(value.amount_minor)}`);
  }
  if (value.currency !== expected.currency) {
    failures.push(`${path}.currency expected ${expected.currency}, got ${describeValue(value.currency)}`);
  }
  if (value.type !== undefined && value.type !== "fixed") {
    failures.push(`${path}.type expected fixed when present, got ${describeValue(value.type)}`);
  }
  return failures;
}

function requireNonFixedMoney(path: string, value: Money | undefined, expectedType: Money["type"]): string[] {
  if (!isRecord(value)) {
    return [`${path} expected Money object, got ${describeValue(value)}`];
  }
  const failures: string[] = [];
  if (value.type !== expectedType) {
    failures.push(`${path}.type expected ${expectedType}, got ${describeValue(value.type)}`);
  }
  if (value.amount_minor !== undefined) {
    failures.push(`${path}.amount_minor expected missing, got ${describeValue(value.amount_minor)}`);
  }
  requireNonEmptyString(failures, `${path}.currency`, value.currency);
  return failures;
}

function requireInstant(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${path} expected non-empty instant string, got ${describeValue(value)}`);
    return;
  }
  if (!hasExplicitOffset(value) || !Number.isFinite(Date.parse(value))) {
    failures.push(`${path} expected RFC 3339 instant with explicit offset, got ${JSON.stringify(value)}`);
  }
}

function requireWallClockDateTime(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    failures.push(`${path} expected wall-clock datetime without offset, got ${describeValue(value)}`);
    return;
  }
  if (hasExplicitOffset(value)) {
    failures.push(`${path} must not carry an offset, got ${JSON.stringify(value)}`);
  }
}

function requireWallClockTime(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value) || hasExplicitOffset(value)) {
    failures.push(`${path} expected wall-clock HH:MM without offset, got ${describeValue(value)}`);
  }
}

function requireNonEmptyString(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${path} expected non-empty string, got ${describeValue(value)}`);
  }
}

function requireFiniteNumber(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failures.push(`${path} expected finite number, got ${describeValue(value)}`);
  }
}

function hasExplicitOffset(value: string): boolean {
  return /Z$/i.test(value) || /[+-]\d{2}:?\d{2}$/.test(value);
}

function summarizeResult<T>(result: AdapterResult<T>): string {
  return result.ok ? "success" : `Problem ${result.problem.code}`;
}

function describeThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function describeValue(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return String(value);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ok<T>(value: T): AdapterResult<T> {
  return { ok: true, value };
}

function problem<T>(code: string, message: string, retryable = false): AdapterResult<T> {
  return {
    ok: false,
    problem: {
      code,
      message,
      retryable
    }
  };
}

function serviceById(id: string): Service | undefined {
  return SYNTHETIC_SERVICES.find((service) => service.id === id);
}

// Adds an ISO 8601 duration ("PT45M", "PT1H") to an offset-free wall-clock
// string, treating it as UTC purely for calendar arithmetic, so the synthetic
// slot's end stays consistent with its start for any requested time.
function addSyntheticDuration(wallClock: string, duration: string | undefined): string {
  const match = (duration ?? "PT45M").match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
  const minutes = match ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0) : 45;
  const asUtc = new Date(`${wallClock}Z`);
  asUtc.setUTCMinutes(asUtc.getUTCMinutes() + minutes);
  return asUtc.toISOString().slice(0, 19);
}

function buildSyntheticSlot(input: {
  service: Service;
  schedule_id: string;
  provider_id: string;
  date: string;
  time?: string;
}): Slot {
  const startsAtLocal = `${input.date}T${normalizeTime(input.time ?? DEFAULT_CONFORMANCE_FIXTURES.time)}`;
  const endsAtLocal = addSyntheticDuration(startsAtLocal, input.service.duration);
  // The synthetic studio is pinned to America/Los_Angeles on a PDT fixture date,
  // so the canonical instants are the wall-clock locals at the -07:00 offset,
  // derived (not hardcoded) so they track a non-default booking time.
  return {
    id: `${input.schedule_id}:${input.provider_id}:${input.service.id}:${startsAtLocal}`,
    organization_id: DEFAULT_CONFORMANCE_FIXTURES.organization_id,
    schedule_id: input.schedule_id,
    schedule_name: "Synthetic Studio",
    schedule_address: "100 Example Street",
    schedule_latitude: 37.789,
    schedule_longitude: -122.401,
    schedule_hours: [
      { day: 1, open: "09:00", close: "17:00" },
      { day: 2, open: "09:00", close: "17:00" }
    ],
    schedule_timezone: "America/Los_Angeles",
    provider_id: input.provider_id,
    provider_name: "Ada Provider",
    provider_has_portfolio: true,
    service_id: input.service.id,
    starts_at: `${startsAtLocal}-07:00`,
    ends_at: `${endsAtLocal}-07:00`,
    starts_at_local: startsAtLocal,
    ends_at_local: endsAtLocal,
    price: clone(input.service.price),
    organization_name: "Synthetic Booking Co."
  };
}

function buildSyntheticPolicy(service: Service): Policy {
  const payment = syntheticPaymentRequirement(service.id);
  const policy: Policy = {
    service_id: service.id,
    cancellation_enabled: true,
    cancellation_window: "PT24H",
    late_grace: "PT15M",
    payment_requirement: payment,
    verification_method: service.id === DEFAULT_CONFORMANCE_FIXTURES.services.verification ? "sms" : "none",
    organization: {
      id: DEFAULT_CONFORMANCE_FIXTURES.organization_id,
      name: "Synthetic Booking Co.",
      slug: "synthetic-booking",
      timezone: "America/Los_Angeles",
      currency: service.price?.currency ?? "USD",
      country: "US",
      total_locations: 1
    }
  };

  if (payment === "deposit") {
    policy.deposit = { amount_minor: 2500, currency: service.price?.currency ?? "USD", type: "fixed" };
  }

  return policy;
}

function syntheticPaymentRequirement(serviceId: string): NonNullable<Policy["payment_requirement"]> {
  if (serviceId === DEFAULT_CONFORMANCE_FIXTURES.services.deposit) {
    return "deposit";
  }
  if (serviceId === DEFAULT_CONFORMANCE_FIXTURES.services.full_prepay) {
    return "full_prepay";
  }
  if (serviceId === DEFAULT_CONFORMANCE_FIXTURES.services.unknown_payment) {
    return "unknown";
  }
  return "none";
}

function normalizeTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const SYNTHETIC_SERVICES: Service[] = [
  {
    id: "svc_fixed_usd",
    name: "Synthetic Haircut",
    duration: "PT45M",
    price: { amount_minor: 9500, currency: "USD", type: "fixed", display: "$95.00" },
    requires_consultation: false,
    options: [
      {
        id: "opt_finish",
        name: "Finishing rinse",
        duration: "PT15M",
        price: { amount_minor: 1500, currency: "USD", type: "fixed", display: "$15.00" }
      }
    ]
  },
  {
    id: "svc_fixed_eur",
    name: "Synthetic EUR Service",
    duration: "PT45M",
    price: { amount_minor: 9000, currency: "EUR", type: "fixed", display: "EUR 90.00" },
    requires_consultation: false
  },
  {
    id: "svc_fixed_gbp",
    name: "Synthetic GBP Service",
    duration: "PT45M",
    price: { amount_minor: 8000, currency: "GBP", type: "fixed", display: "GBP 80.00" },
    requires_consultation: false
  },
  {
    id: "svc_fixed_jpy",
    name: "Synthetic JPY Service",
    duration: "PT45M",
    price: { amount_minor: 12000, currency: "JPY", type: "fixed", display: "JPY 12000" },
    requires_consultation: false
  },
  {
    id: "svc_fixed_kwd",
    name: "Synthetic KWD Service",
    duration: "PT45M",
    price: { amount_minor: 12500, currency: "KWD", type: "fixed", display: "KWD 12.500" },
    requires_consultation: false
  },
  {
    id: "svc_insurance",
    name: "Synthetic Insurance Service",
    duration: "PT45M",
    price: { currency: "USD", type: "insurance_dependent", display: "Varies by insurance" },
    requires_consultation: false
  },
  {
    id: "svc_quote",
    name: "Synthetic Quote Service",
    duration: "PT45M",
    price: { currency: "USD", type: "quote_required", display: "Quote required" },
    requires_consultation: false
  },
  {
    id: "svc_consultation",
    name: "Synthetic Consultation Service",
    duration: "PT45M",
    price: { amount_minor: 9500, currency: "USD", type: "fixed", display: "$95.00" },
    requires_consultation: true
  },
  {
    id: "svc_deposit",
    name: "Synthetic Deposit Service",
    duration: "PT45M",
    price: { amount_minor: 9500, currency: "USD", type: "fixed", display: "$95.00" },
    requires_consultation: false
  },
  {
    id: "svc_full_prepay",
    name: "Synthetic Full Prepay Service",
    duration: "PT45M",
    price: { amount_minor: 9500, currency: "USD", type: "fixed", display: "$95.00" },
    requires_consultation: false
  },
  {
    id: "svc_unknown_payment",
    name: "Synthetic Unknown Payment Service",
    duration: "PT45M",
    price: { amount_minor: 9500, currency: "USD", type: "fixed", display: "$95.00" },
    requires_consultation: false
  },
  {
    id: "svc_verification",
    name: "Synthetic Verification Service",
    duration: "PT45M",
    price: { amount_minor: 9500, currency: "USD", type: "fixed", display: "$95.00" },
    requires_consultation: false
  }
];
