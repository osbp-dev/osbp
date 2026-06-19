import type { BookingMandate, Money, OsbpToolName, Policy, Problem, Service, Slot } from "./index.js";

export interface MandateValidationInput {
  mandate: BookingMandate;
  action: OsbpToolName;
  organization_id: string;
  service?: Service;
  slot?: Slot;
  policy?: Policy;
  now?: Date;
}

export type MandateValidationResult =
  | { ok: true }
  | { ok: false; problem: Problem };

export function validateMandate(input: MandateValidationInput): MandateValidationResult {
  const now = input.now ?? new Date();
  const mandate = input.mandate;

  if (!mandate.id) {
    return reject("invalid_mandate", "BookingMandate.id is required");
  }

  // Trust-boundary shape guard. The TS types describe the shape we expect, but
  // validateMandate is exported and called by third-party adapters with
  // runtime-constructed mandates. A malformed or hostile mandate can violate
  // the types, so reject bad shapes here; otherwise a string scope silently
  // becomes substring matching and a missing allowed_actions throws.
  if (!Array.isArray(mandate.allowed_actions)) {
    return reject("invalid_mandate", "BookingMandate.allowed_actions must be an array");
  }
  for (const [field, scope] of [
    ["service_ids", mandate.service_ids],
    ["provider_ids", mandate.provider_ids],
    ["schedule_ids", mandate.schedule_ids]
  ] as const) {
    if (scope !== undefined && !Array.isArray(scope)) {
      return reject("invalid_mandate", `BookingMandate.${field} must be an array when present`);
    }
  }

  if (!hasExplicitOffset(mandate.expires_at)) {
    return reject(
      "invalid_mandate",
      "BookingMandate.expires_at must include an explicit timezone (`Z` or `±HH:MM`); naked wall-clock strings parse as host-local and silently shift by the host's offset"
    );
  }

  if (!isFutureInstant(mandate.expires_at, now)) {
    return reject("mandate_expired", "BookingMandate has expired");
  }

  if (!mandate.allowed_actions.includes(input.action)) {
    return reject("action_not_allowed", `${input.action} is outside BookingMandate.allowed_actions`);
  }

  if (mandate.organization_id !== input.organization_id) {
    return reject("organization_not_allowed", "Selected organization is outside BookingMandate scope");
  }

  // Mutation evidence gate. booking.create is the only mutating action; it must
  // carry the full service/slot/policy evidence so no later scope check is
  // silently skipped (an absent slot skips the time-window check; an absent
  // policy skips the payment/deposit check), and that evidence must describe
  // one service so a safe-looking object cannot authorize a different target.
  if (input.action === "booking.create") {
    if (!input.service || !input.slot || !input.policy) {
      return reject(
        "invalid_mandate",
        "booking.create requires service, slot, and policy evidence; fail closed"
      );
    }
    const evidenceServiceIds = [input.service.id, input.slot.service_id, input.policy.service_id].filter(
      (id): id is string => id !== undefined
    );
    if (new Set(evidenceServiceIds).size > 1) {
      return reject(
        "invalid_mandate",
        "Selected service, slot, and policy evidence must describe the same service; fail closed"
      );
    }
  }

  const serviceId = input.service?.id ?? input.slot?.service_id ?? input.policy?.service_id;
  if (!isAllowed(serviceId, mandate.service_ids)) {
    return reject("service_not_allowed", "Selected service is outside BookingMandate scope");
  }

  if (input.slot) {
    const slotValidation = validateSlotScope(mandate, input.slot);
    if (!slotValidation.ok) {
      return slotValidation;
    }
  }

  const priceValidation = validatePriceScope(mandate, input.service, input.slot, input.action);
  if (!priceValidation.ok) {
    return priceValidation;
  }

  const policyValidation = validatePolicyScope(mandate, input.policy, input.service);
  if (!policyValidation.ok) {
    return policyValidation;
  }

  return { ok: true };
}

function validateSlotScope(mandate: BookingMandate, slot: Slot): MandateValidationResult {
  // Enforce the wall-clock side of the time-discipline rule (see the spec
  // Time Discipline section, schema.md#time-discipline). The four fields below
  // are wall-clock by contract; tz-aware values would shift compareDateLike
  // results by the host's offset under Date.parse and silently misjudge slot
  // scope. Reject before the comparators run. Mirror of the instant-side
  // strictness on BookingMandate.expires_at; same hasExplicitOffset helper,
  // inverse assertion. Note: Slot now also carries absolute-instant
  // starts_at / ends_at (which MUST carry an offset); those are deliberately
  // NOT in this list and the validator never compares them against the
  // wall-clock mandate window.
  const wallClockFields: ReadonlyArray<readonly [string, string | undefined]> = [
    ["BookingMandate.earliest_start", mandate.earliest_start],
    ["BookingMandate.latest_end", mandate.latest_end],
    ["Slot.starts_at_local", slot.starts_at_local],
    ["Slot.ends_at_local", slot.ends_at_local]
  ];
  for (const [name, value] of wallClockFields) {
    if (value === undefined) {
      continue;
    }
    if (hasExplicitOffset(value)) {
      return reject(
        "invalid_mandate",
        `${name} must be wall-clock (no tz offset); got ${JSON.stringify(value)}. Wall-clock comparators silently shift by the host's timezone when given mixed-category inputs; see the spec Time Discipline section.`
      );
    }
    if (!isWallClockDateTime(value)) {
      return reject(
        "invalid_mandate",
        `${name} must be a wall-clock datetime like 2026-07-07T09:00 (no offset); got ${JSON.stringify(value)}. Date-only or unparsable values fall back to lexical comparison and silently widen the window.`
      );
    }
  }

  if (!isAllowed(slot.schedule_id, mandate.schedule_ids)) {
    return reject("schedule_not_allowed", "Selected schedule is outside BookingMandate scope");
  }

  if (mandate.provider_ids && !slot.provider_id) {
    return reject("provider_unknown", "Selected slot does not identify provider required by BookingMandate scope");
  }

  if (!isAllowed(slot.provider_id, mandate.provider_ids)) {
    return reject("provider_not_allowed", "Selected provider is outside BookingMandate scope");
  }

  if (!isAtOrAfter(slot.starts_at_local, mandate.earliest_start)) {
    return reject("slot_too_early", "Selected slot starts before BookingMandate.earliest_start");
  }

  const slotEnd = slot.ends_at_local ?? slot.starts_at_local;
  if (!isAtOrBefore(slotEnd, mandate.latest_end)) {
    return reject("slot_too_late", "Selected slot ends after BookingMandate.latest_end");
  }

  return { ok: true };
}

function validatePriceScope(
  mandate: BookingMandate,
  service: Service | undefined,
  slot: Slot | undefined,
  action: OsbpToolName
): MandateValidationResult {
  const price = slot?.price ?? service?.price;
  const cap = mandate.max_price;

  // An absent cap means the user did not restrict price on this dimension, so
  // there is nothing to bound. A present cap must actually bound the price: for
  // a mutation, a cap that cannot be applied (no numeric ceiling, or no fixed
  // price to compare against) is unbounded authority and fails closed, mirroring
  // the policy-fee path rather than silently passing.
  if (!cap) {
    return { ok: true };
  }

  const isMutation = action === "booking.create";

  if (cap.amount_minor !== undefined) {
    if (!price || price.amount_minor === undefined) {
      return isMutation
        ? reject(
            "requires_user_confirmation",
            "BookingMandate.max_price sets a numeric cap but the selected service or slot has no fixed price to bound it; fail closed"
          )
        : { ok: true };
    }
    if (price.currency !== cap.currency) {
      return reject(
        "currency_mismatch",
        "Selected price currency does not match BookingMandate.max_price currency; fail closed for new user approval"
      );
    }
    if (price.amount_minor > cap.amount_minor) {
      return reject("price_exceeds_mandate", "Selected service or slot price exceeds BookingMandate.max_price");
    }
    return { ok: true };
  }

  // Cap present but currency-only: it carries no numeric ceiling to bound by.
  if (price && price.amount_minor !== undefined && price.currency !== cap.currency) {
    return reject(
      "currency_mismatch",
      "Selected price currency does not match BookingMandate.max_price currency; fail closed for new user approval"
    );
  }
  return isMutation
    ? reject(
        "requires_user_confirmation",
        "BookingMandate.max_price carries only a currency and no amount to bound the price; fail closed for new user approval"
      )
    : { ok: true };
}

function validatePolicyScope(
  mandate: BookingMandate,
  policy: Policy | undefined,
  service: Service | undefined
): MandateValidationResult {
  // Fail closed unconditionally on consultation services. hasConsultation: true
  // services drive a 4-step quote workflow (consultation
  // form → quote → quote-pinned booking with ServiceRequest.id as requestId)
  // that OSBP v0.1.0 cannot drive end-to-end. There is intentionally no
  // mandate opt-in: the upstream call cannot succeed for these services
  // today, so an `allow_consultation` bypass would just route the agent
  // into the failure mode the validator is meant to close.
  if (service?.requires_consultation === true) {
    return reject(
      "requires_consultation_handoff",
      "Selected service requires a consultation/quote workflow that OSBP v0.1.0 cannot drive; route to handoff.request"
    );
  }

  if (!policy?.payment_requirement || policy.payment_requirement === "none") {
    return { ok: true };
  }

  if (policy.payment_requirement === "unknown") {
    return reject("requires_user_confirmation", "Payment requirement is unknown; fail closed before mutation");
  }

  const requiredFee: Money | undefined = policy.payment_requirement === "full_prepay"
    ? service?.price
    : policy.deposit;

  if (!mandate.allow_policy_fee) {
    return reject("requires_payment_handoff", "BookingMandate does not allow required payment or policy fees");
  }

  const cap = mandate.max_extra_fee;
  if (cap && cap.amount_minor !== undefined) {
    if (!requiredFee || requiredFee.amount_minor === undefined) {
      return reject(
        "requires_user_confirmation",
        "Required payment amount is not a fixed amount at booking time, so the mandate cap cannot bound it; fail closed"
      );
    }
    if (requiredFee.currency !== cap.currency) {
      return reject(
        "currency_mismatch",
        "Required fee currency does not match BookingMandate.max_extra_fee currency; fail closed for new user approval"
      );
    }
    if (requiredFee.amount_minor > cap.amount_minor) {
      return reject("policy_fee_exceeds_mandate", "Required payment or policy fee exceeds BookingMandate.max_extra_fee");
    }
  } else {
    if (cap?.currency && requiredFee?.amount_minor !== undefined && requiredFee.currency !== cap.currency) {
      return reject(
        "currency_mismatch",
        "Required fee currency does not match BookingMandate.max_extra_fee currency; fail closed for new user approval"
      );
    }
    if (!requiredFee || requiredFee.amount_minor === undefined) {
      return reject("requires_user_confirmation", "Required payment amount is unknown; fail closed before mutation");
    }
  }

  return { ok: true };
}

function isAllowed(value: string | undefined, allowedValues: string[] | undefined): boolean {
  // An omitted scope array (undefined) means no restriction on this dimension.
  // An empty array is a present-but-empty allow-list: it allows nothing and
  // fails closed, rather than being read as unrestricted on the trust boundary.
  return !allowedValues || (value !== undefined && allowedValues.includes(value));
}

function isFutureInstant(value: string, now: Date): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now.getTime();
}

// Enforces the wall-clock-vs-instant rule (see the spec Time Discipline
// section, schema.md#time-discipline): instant fields
// (BookingMandate.expires_at, AuditEvent.created_at) MUST carry an explicit
// timezone. A naked ISO string here would parse in the host's local tz under
// Date.parse, so a remote MCP host running in a different region from the
// merchant would silently expire mandates by hours.
function hasExplicitOffset(value: string): boolean {
  // RFC 3339 offset patterns: trailing Z (case-insensitive), or `±HH:MM`
  // / `±HHMM` after the seconds component.
  return /Z$/i.test(value) || /[+-]\d{2}:?\d{2}$/.test(value);
}

function isWallClockDateTime(value: string): boolean {
  // Wall-clock datetime: a date plus a time, no offset (the offset case is
  // rejected separately). Requiring the time component rejects date-only
  // strings, whose comparison drifts by the host offset; requiring a parseable
  // value rejects garbage that would otherwise fall through to the lexical
  // comparison in compareDateLike and silently widen the window.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isAtOrAfter(value: string, lowerBound: string | undefined): boolean {
  return lowerBound === undefined || compareDateLike(value, lowerBound) >= 0;
}

function isAtOrBefore(value: string, upperBound: string | undefined): boolean {
  return upperBound === undefined || compareDateLike(value, upperBound) <= 0;
}

function compareDateLike(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime - rightTime;
  }

  return left.localeCompare(right);
}

function reject(code: string, message: string): MandateValidationResult {
  return {
    ok: false,
    problem: {
      code,
      message,
      retryable: false
    }
  };
}
