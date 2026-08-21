#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  inspectOpeningsIdempotencyKey,
  OpeningsAdapter,
  loadOpeningsConfigFromEnv,
  loadOsbpEnv,
  removeOpeningsIdempotencyKey
} from "../../../packages/openings-adapter/dist/index.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const liveBookingApproved = process.argv.includes("--approve-live-booking");
const preflightLiveBooking = process.argv.includes("--preflight-live-booking");
const resetGoldenIdempotency = process.argv.includes("--reset-golden-idempotency");
const goldenTraceIdempotencyKey = "idem_openings_v0_1_0_create_001";
// Relayed OTP for the Openings SMS verification gate. Obtain it out of band
// (sendVerification + an SMS receiver), then pass --code=NNNN to complete a
// real booking. Without it, the create call fails closed at requires_verification.
const verificationCode = (process.argv.find((a) => a.startsWith("--code=")) || "").split("=")[1];
// Layered: root .env.local wins over this example's .env.local; process.env wins over both.
const env = { ...loadOsbpEnv(repoRoot), ...process.env };
const config = loadOpeningsConfigFromEnv(env);
if (config.idempotencyStorePath && !isAbsolute(config.idempotencyStorePath)) {
  config.idempotencyStorePath = resolve(repoRoot, config.idempotencyStorePath);
}
prepareGoldenTraceIdempotency(config.idempotencyStorePath, {
  approveLiveBooking: liveBookingApproved || preflightLiveBooking,
  reset: resetGoldenIdempotency
});
if (preflightLiveBooking) {
  console.log("Golden-trace live-booking preflight passed.");
  process.exit(0);
}
const adapter = new OpeningsAdapter(config);

const trace = await buildTrace(adapter, liveBookingApproved, verificationCode);
const tracePath = resolve(repoRoot, "traces/v0.1.0/openings-create.json");
const preserveBookedTrace = trace.status !== "booked" && existingTraceStatus(tracePath) === "booked";

mkdirSync(resolve(repoRoot, "traces/v0.1.0"), { recursive: true });
if (!preserveBookedTrace) {
  writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`);
}

console.log(`${preserveBookedTrace ? "Preserved booked trace at" : "Wrote"} ${tracePath}`);
console.log(`Trace status: ${trace.status}`);
if (preserveBookedTrace) {
  console.log("Existing booked trace was left unchanged because the retry did not produce a booked result.");
}
if (trace.status === "awaiting_live_booking_approval") {
  console.log("Re-run with --approve-live-booking only after approving the selected slot.");
}
// Surface the underlying failure so a preserved-trace run still tells the
// operator *why* it failed. Without this, the actual problem code lives
// only in the in-memory trace that never gets written.
if (trace.status === "booking_create_failed" || trace.status === "requires_verification") {
  const problem = trace.booking_create?.problem;
  if (problem) {
    console.error(`booking.create failed: ${problem.code}: ${problem.message}`);
    if (problem.retryable) console.error("(retryable)");
  }
}
if (trace.selected_slot) {
  console.log(`Selected slot: ${trace.selected_slot.starts_at_local} (tz ${trace.selected_slot.schedule_timezone ?? "unknown"}, instant ${trace.selected_slot.starts_at ?? "unknown"})`);
}

function prepareGoldenTraceIdempotency(storePath, { approveLiveBooking, reset }) {
  if (reset) {
    if (!storePath) {
      console.warn("--reset-golden-idempotency requested, but no persistent OSBP_IDEMPOTENCY_STORE_PATH is configured; in-memory stores cannot be reset across process runs.");
    } else {
      const removed = removeOpeningsIdempotencyKey(storePath, goldenTraceIdempotencyKey);
      console.log(removed
        ? `Removed fixed golden-trace idempotency key from ${storePath}: ${goldenTraceIdempotencyKey}`
        : approveLiveBooking
          ? `No fixed golden-trace idempotency key was removed from ${storePath}; verifying store integrity before live booking.`
          : `No fixed golden-trace idempotency key found in ${storePath}: ${goldenTraceIdempotencyKey}`);
    }
  }

  if (!approveLiveBooking) {
    return;
  }

  if (!storePath) {
    console.warn("No persistent OSBP_IDEMPOTENCY_STORE_PATH is configured; the golden-trace idempotency guard cannot preflight in-memory stores across process runs.");
    return;
  }

  let idempotencyInspection;
  try {
    idempotencyInspection = inspectOpeningsIdempotencyKey(storePath, goldenTraceIdempotencyKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Refusing live golden-trace booking because the configured idempotency store ${storePath} could not be verified: ${message}`
    );
  }

  if (idempotencyInspection.keyPresent) {
    throw new Error(
      `Refusing live golden-trace booking because ${goldenTraceIdempotencyKey} already exists in ${storePath}. ` +
      "Re-run with --reset-golden-idempotency only if you intend to create another controlled live appointment; " +
      "clean up controlled live appointments with tools/local-harness/cancel-live-test.mjs."
    );
  }
}

async function buildTrace(adapter, approveLiveBooking, verificationCode) {
  const serviceId = adapter.config.serviceIds[0];
  const scheduleId = adapter.config.scheduleIds[0];
  const salonId = adapter.config.salonId;

  if (!serviceId || !scheduleId || !salonId) {
    throw new Error("OPENINGS_SALON_ID, OPENINGS_SCHEDULE_IDS, and OPENINGS_SERVICE_IDS are required");
  }

  const service = unwrap(await adapter.describeService({ service_id: serviceId }), "service.describe");
  const policy = unwrap(await adapter.explainPolicy({ service_id: serviceId }), "policy.explain");
  const availability = await findAvailability(adapter, serviceId, scheduleId);
  const selectedSlot = availability.slots[0];

  if (!selectedSlot) {
    throw new Error("No availability found in the next 14 days");
  }

  const configuredCustomerId = adapter.config.customerId ?? adapter.config.testCustomerId;
  const configuredCustomerPhone = adapter.config.customerPhone ?? adapter.config.testCustomerPhone;
  const configuredCustomerDisplayName = "Jane Smith";
  const textRedactionSecrets = [configuredCustomerDisplayName];
  const aliases = createTraceAliases({
    serviceId,
    selectedServiceId: selectedSlot.service_id,
    scheduleId,
    selectedScheduleId: selectedSlot.schedule_id,
    selectedProviderId: selectedSlot.provider_id,
    customerId: configuredCustomerId
  });
  seedAvailabilityAliases(aliases, availability.slots);
  // Build the price cap as a Money whose currency matches the selected price,
  // or the validator's cross-currency guard rejects the booking. Falls back to
  // the slot/service currency, then USD for the configured Openings business.
  const capCurrency =
    selectedSlot.price?.currency ?? service.price?.currency ?? "USD";
  const capAmountMinor = service.price?.amount_minor ?? 10000;
  const mandate = {
    id: "mnd_openings_v0_1_0_create_001",
    // Relative to now so the generator keeps working over time: a fixed date
    // silently expires and every run fails closed with mandate_expired.
    // The mandate authorizes the create call, which happens now; a 1-day window
    // is comfortably valid. (The read-only path never validates this.)
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    allowed_actions: ["booking.create"],
    organization_id: "openings_business",
    service_ids: [aliases.service(selectedSlot.service_id)],
    provider_ids: selectedSlot.provider_id ? [aliases.provider(selectedSlot.provider_id)] : undefined,
    schedule_ids: [aliases.schedule(selectedSlot.schedule_id)],
    // earliest_start / latest_end are wall-clock by contract, so use the slot's
    // wall-clock fields, not the absolute instant. Openings availability slots
    // carry only starts_at_local, but createBooking derives the slot end from
    // the service duration and validates it against latest_end. Fall back to
    // end-of-day so a real (non-zero-duration) slot is not rejected slot_too_late.
    earliest_start: selectedSlot.starts_at_local,
    latest_end: selectedSlot.ends_at_local ?? `${selectedSlot.starts_at_local.slice(0, 10)}T23:59:00`,
    max_price: { amount_minor: capAmountMinor, currency: capCurrency },
    allow_policy_fee: false,
    max_extra_fee: { amount_minor: 0, currency: capCurrency }
  };

  const bookingInput = {
    mandate: {
      ...mandate,
      organization_id: salonId,
      service_ids: [selectedSlot.service_id],
      provider_ids: selectedSlot.provider_id ? [selectedSlot.provider_id] : undefined,
      schedule_ids: [selectedSlot.schedule_id]
    },
    idempotency_key: goldenTraceIdempotencyKey,
    service_id: selectedSlot.service_id,
    schedule_id: selectedSlot.schedule_id,
    provider_id: selectedSlot.provider_id ?? adapter.config.providerUserIds[0],
    // date / time are wall-clock; pull them from the slot's wall-clock field.
    date: selectedSlot.starts_at_local.slice(0, 10),
    time: selectedSlot.starts_at_local.slice(11, 16),
    customer: {
      id: configuredCustomerId,
      phone: configuredCustomerPhone,
      display_name: configuredCustomerDisplayName
    },
    ...(verificationCode ? { verification_code: verificationCode } : {})
  };

  const baseTrace = {
    trace_id: "trace_openings_v0_1_0_create_001",
    protocol_version: "0.1.0",
    generated_at: new Date().toISOString(),
    source: "osbp-v0.1.0-local",
    redaction: {
      live_business_ids: "aliased",
      customer_phone: "redacted",
      customer_name: "redacted",
      verification_code: "redacted"
    },
    user_request: "Book one controlled live appointment at the configured Openings business. Ask for final approval before booking.",
    mandate,
    tool_calls: [
      {
        tool: "osbp_service_describe",
        input: {
          service_id: aliases.service(serviceId)
        },
        output: {
          service: redactService(service, aliases)
        }
      },
      {
        tool: "osbp_availability_find",
        input: {
          service_id: aliases.service(serviceId),
          schedule_id: aliases.schedule(scheduleId),
          date: availability.date
        },
        output: {
          slot_count: availability.slots.length,
          slots: availability.slots
            .slice(0, 5)
            .map((slot, index) => redactSlot(slot, aliases, `slot_${index + 1}`))
        }
      },
      {
        tool: "osbp_policy_explain",
        input: {
          service_id: aliases.service(serviceId)
        },
        output: {
          policy: redactPolicy(policy, aliases)
        }
      }
    ],
    selected_slot: redactSlot(selectedSlot, aliases, "slot_selected"),
    policy_readback: redactPolicy(policy, aliases),
    final_approval_text: redactFreeText(approvalText(service, selectedSlot, policy), textRedactionSecrets),
    audit_event_ids: [
      "aud_service_describe_001",
      "aud_availability_find_001",
      "aud_policy_explain_001"
    ]
  };

  if (!approveLiveBooking) {
    return {
      ...baseTrace,
      status: "awaiting_live_booking_approval",
      unique_ids: summarizeAliases(aliases),
      booking_create: {
        skipped: true,
        reason: "Live booking requires explicit final approval for the selected slot."
      },
      receipt: null
    };
  }

  // --approve-live-booking is the operator's final approval. The first create
  // returns requires_user_confirmation with a one-time token; relay it back with
  // approval.confirmed=true to complete the booking, the same two-step handshake
  // an agent host performs after the user approves the summary.
  const preflightResult = await adapter.createBooking(bookingInput);
  const bookingCreatePreflightCall = {
    tool: "osbp_booking_create",
    input: {
      ...redactBookingInput(bookingInput, aliases),
      mandate
    },
    output: preflightResult.ok
      ? {
        receipt: redactReceipt(preflightResult.value, aliases, textRedactionSecrets)
      }
      : {
        problem: redactProblem(preflightResult.problem, textRedactionSecrets)
      }
  };

  const bookingCreateCalls = [bookingCreatePreflightCall];
  let finalApprovalText = preflightResult.ok
    ? baseTrace.final_approval_text
    : redactFreeText(
      approvalSummaryFromProblem(preflightResult.problem.message) ?? baseTrace.final_approval_text,
      textRedactionSecrets
    );
  let createResult = preflightResult;
  let approvedBookingInput = bookingInput;

  if (!preflightResult.ok && preflightResult.problem.code === "requires_user_confirmation") {
    const token = approvalTokenFromProblem(preflightResult.problem.message);
    if (token) {
      approvedBookingInput = {
        ...bookingInput,
        approval: { confirmed: true, token }
      };
      createResult = await adapter.createBooking(approvedBookingInput);
      bookingCreateCalls.push({
        tool: "osbp_booking_create",
        input: {
          ...redactBookingInput(approvedBookingInput, aliases),
          mandate
        },
        output: createResult.ok
          ? {
            receipt: redactReceipt(createResult.value, aliases, textRedactionSecrets)
          }
          : {
            problem: redactProblem(createResult.problem, textRedactionSecrets)
          }
      });
    }
  }
  const bookingCreateCall = {
    output: bookingCreateCalls.at(-1).output
  };

  if (!createResult.ok) {
    return {
      ...baseTrace,
      final_approval_text: finalApprovalText,
      status: createResult.problem.code === "requires_verification"
        ? "requires_verification"
        : "booking_create_failed",
      tool_calls: [...baseTrace.tool_calls, ...bookingCreateCalls],
      unique_ids: summarizeAliases(aliases),
      booking_create_preflight: bookingCreatePreflightCall.output,
      booking_create: bookingCreateCall.output,
      receipt: null,
      audit_event_ids: [
        ...baseTrace.audit_event_ids,
        "aud_booking_create_preflight_001",
        ...(bookingCreateCalls.length > 1 ? ["aud_booking_create_001"] : [])
      ]
    };
  }

  const statusResult = await adapter.getBooking({
    booking_id: createResult.value.booking_id,
    customer: approvedBookingInput.customer
  });

  return {
    ...baseTrace,
    final_approval_text: finalApprovalText,
    status: "booked",
    tool_calls: [
      ...baseTrace.tool_calls,
      ...bookingCreateCalls,
      {
        tool: "osbp_booking_status",
        input: {
          booking_id: aliases.booking(createResult.value.booking_id),
          customer: {
            id: aliases.customer(approvedBookingInput.customer.id),
            phone: "[redacted]"
          }
        },
        output: statusResult.ok ? { booking: redactBooking(statusResult.value, aliases) } : { problem: redactProblem(statusResult.problem, textRedactionSecrets) }
      }
    ],
    unique_ids: summarizeAliases(aliases),
    booking_create_preflight: bookingCreatePreflightCall.output,
    booking_create: bookingCreateCall.output,
    booking_status: statusResult.ok ? redactBooking(statusResult.value, aliases) : null,
    receipt: redactReceipt(createResult.value, aliases, textRedactionSecrets),
    audit_event_ids: [
      ...baseTrace.audit_event_ids,
      "aud_booking_create_preflight_001",
      "aud_booking_create_001",
      "aud_booking_status_001"
    ]
  };
}

async function findAvailability(adapter, serviceId, scheduleId) {
  for (let offset = 1; offset <= 14; offset += 1) {
    const date = nextDateIso(offset);
    const result = unwrap(await adapter.findAvailability({
      service_id: serviceId,
      schedule_id: scheduleId,
      date
    }), "availability.find");

    if (result.length > 0) {
      return { date, slots: result };
    }
  }

  return { date: nextDateIso(14), slots: [] };
}

function unwrap(result, label) {
  if (!result.ok) {
    throw new Error(`${label}: ${result.problem.code}: ${result.problem.message}`);
  }

  return result.value;
}

function redactService(service, aliases) {
  return {
    id: aliases.service(service.id),
    name: service.name,
    duration: service.duration,
    price: service.price
  };
}

function redactSlot(slot, aliases, id = "slot_selected") {
  // Explicit allowlist (AGENTS.md "Allowlist Trace Redaction"): when adding a
  // Slot field, decide here whether it appears in the trace. starts_at is the
  // absolute instant; starts_at_local / ends_at_local are the wall-clock
  // values; schedule_timezone interprets the wall-clock ones. None carry PII
  // or live ids, so all are emitted.
  return {
    id,
    schedule_id: aliases.schedule(slot.schedule_id),
    provider_id: aliases.provider(slot.provider_id),
    service_id: aliases.service(slot.service_id),
    starts_at: slot.starts_at,
    ends_at: slot.ends_at,
    starts_at_local: slot.starts_at_local,
    ends_at_local: slot.ends_at_local,
    schedule_timezone: slot.schedule_timezone,
    price: slot.price
  };
}

function createTraceAliases({
  serviceId,
  selectedServiceId,
  scheduleId,
  selectedScheduleId,
  selectedProviderId,
  customerId
}) {
  return {
    service: createIdAliaser("service", [
      [serviceId, "service_primary"],
      [selectedServiceId, "service_selected"]
    ]),
    schedule: createIdAliaser("schedule", [
      [scheduleId, "schedule_primary"],
      [selectedScheduleId, "schedule_selected"]
    ]),
    provider: createIdAliaser("provider", [[selectedProviderId, "provider_selected"]]),
    booking: createIdAliaser("booking"),
    customer: createIdAliaser("customer", [[customerId, "customer_configured"]], "customer_configured")
  };
}

function createIdAliaser(prefix, pinned = [], firstGeneratedAlias) {
  const liveToAlias = new Map();
  const usedAliases = new Set();

  for (const [liveId, alias] of pinned) {
    if (liveId && !liveToAlias.has(liveId)) {
      liveToAlias.set(liveId, alias);
      usedAliases.add(alias);
    }
  }

  const aliaser = (liveId) => {
    if (!liveId) {
      return undefined;
    }

    if (!liveToAlias.has(liveId)) {
      let index = liveToAlias.size + 1;
      let alias = firstGeneratedAlias && !usedAliases.has(firstGeneratedAlias)
        ? firstGeneratedAlias
        : `${prefix}_${index}`;
      while (usedAliases.has(alias)) {
        index += 1;
        alias = `${prefix}_${index}`;
      }
      liveToAlias.set(liveId, alias);
      usedAliases.add(alias);
    }

    return liveToAlias.get(liveId);
  };

  aliaser.summary = () => ({
    count: liveToAlias.size,
    aliases: [...liveToAlias.values()]
  });

  return aliaser;
}

function seedAvailabilityAliases(aliases, slots) {
  for (const slot of slots) {
    aliases.service(slot.service_id);
    aliases.schedule(slot.schedule_id);
    aliases.provider(slot.provider_id);
  }
}

function summarizeAliases(aliases) {
  return {
    service_ids: aliases.service.summary(),
    provider_ids: aliases.provider.summary(),
    schedule_ids: aliases.schedule.summary(),
    booking_ids: aliases.booking.summary(),
    customer_ids: aliases.customer.summary()
  };
}

function redactReceipt(receipt, aliases, textRedactionSecrets = []) {
  const bookingId = aliases.booking(receipt.booking_id);
  return {
    id: "receipt_openings_create_001",
    booking_id: bookingId,
    text: redactFreeText(receipt.text.replaceAll(receipt.booking_id, bookingId), textRedactionSecrets)
  };
}

function redactProblem(problem, textRedactionSecrets = []) {
  return {
    code: problem.code,
    message: redactFreeText(problem.message, textRedactionSecrets),
    retryable: problem.retryable
  };
}

function approvalTokenFromProblem(message) {
  const tokenMatch = message.match(/approval\.token=(?:"([^"]+)"|(\S+))/);
  return tokenMatch?.[1] ?? tokenMatch?.[2];
}

function approvalSummaryFromProblem(message) {
  const prefix = "User-facing approval summary: ";
  const suffix = " Agent retry instruction:";
  const start = message.indexOf(prefix);
  const end = message.indexOf(suffix);
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return message.slice(start + prefix.length, end).trim();
}

function redactFreeText(text, textRedactionSecrets = []) {
  let redacted = text;
  for (const secret of textRedactionSecrets) {
    const value = secret?.trim();
    if (value) {
      redacted = redacted.replace(new RegExp(escapeRegExp(value), "gi"), "[redacted]");
    }
  }
  return redacted
    .replace(/approval\.token=(?:"[^"]+"|\S+)/g, 'approval.token="[redacted]"')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (match) => {
      const digits = match.replace(/\D/g, "");
      const phoneish = match.trim().startsWith("+") || digits.length >= 10 || /[()]/.test(match);
      return digits.length >= 7 && phoneish ? "[redacted]" : match;
    });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function approvalText(service, slot, policy) {
  const price = slot.price?.display ?? service.price?.display;
  const provider = slot.provider_name ? ` with ${slot.provider_name}` : "";
  const location = slot.schedule_name
    ? ` at ${slot.schedule_name}${slot.schedule_address ? ` (${slot.schedule_address})` : ""}`
    : "";
  const priceText = price ? `, priced at ${price}` : "";
  const policyText = policy.payment_requirement && policy.payment_requirement !== "none"
    ? ` Policy/payment requirement: ${policy.payment_requirement}.`
    : " No upfront payment or deposit is required to book.";
  return `Approve ${service.name} on ${slot.starts_at_local} merchant-local time${provider}${location}${priceText}.${policyText}`;
}

function redactPolicy(policy, aliases) {
  return {
    service_id: aliases.service(policy.service_id),
    cancellation_note: policy.cancellation_note,
    // Conditional-liability fees, peers of deposit: non-PII Money objects that
    // show the user what a cancellation or no-show could cost. Allowlisted
    // explicitly (see AGENTS.md "Allowlist Trace Redaction"). Undefined when the
    // platform exposes no fee, in which case the trace omits the key.
    cancellation_fee: policy.cancellation_fee,
    no_show_fee: policy.no_show_fee,
    payment_requirement: policy.payment_requirement,
    deposit: policy.deposit
  };
}

function redactBookingInput(input, aliases) {
  const redacted = {
    idempotency_key: input.idempotency_key,
    service_id: aliases.service(input.service_id),
    schedule_id: aliases.schedule(input.schedule_id),
    provider_id: aliases.provider(input.provider_id),
    date: input.date,
    time: input.time,
    customer: {
      id: aliases.customer(input.customer.id),
      phone: "[redacted]"
    }
  };
  if (input.customer.display_name) {
    redacted.customer.display_name = "[redacted]";
  }
  if (input.customer.given_name) {
    redacted.customer.given_name = "[redacted]";
  }
  if (input.customer.family_name) {
    redacted.customer.family_name = "[redacted]";
  }
  if (input.approval) {
    redacted.approval = {
      confirmed: input.approval.confirmed,
      token: "[redacted]"
    };
  }
  return redacted;
}

function redactBooking(booking, aliases) {
  return {
    id: aliases.booking(booking.id),
    status: booking.status,
    service_id: aliases.service(booking.service_id),
    schedule_id: aliases.schedule(booking.schedule_id),
    provider_id: aliases.provider(booking.provider_id),
    starts_at: booking.starts_at,
    starts_at_local: booking.starts_at_local,
    schedule_timezone: booking.schedule_timezone,
    customer_id: aliases.customer(booking.customer_id)
  };
}

function nextDateIso(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function existingTraceStatus(path) {
  if (!existsSync(path)) {
    return undefined;
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")).status;
  } catch {
    return undefined;
  }
}
