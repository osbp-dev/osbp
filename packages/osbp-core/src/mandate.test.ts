import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BookingMandate, Policy, Service, Slot } from "./index.js";
import { validateMandate } from "./mandate.js";

const now = new Date("2026-05-01T12:00:00Z");

const mandate: BookingMandate = {
  id: "mandate_1",
  expires_at: "2026-05-01T13:00:00Z",
  allowed_actions: ["booking.create"],
  organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
  service_ids: ["service_1"],
  provider_ids: ["provider_1"],
  schedule_ids: ["schedule_1"],
  earliest_start: "2026-05-02T09:00:00",
  latest_end: "2026-05-02T18:00:00",
  max_price: { amount_minor: 10000, currency: "USD" },
  allow_policy_fee: false,
  max_extra_fee: { amount_minor: 0, currency: "USD" }
};

const service: Service = {
  id: "service_1",
  name: "Haircut",
  price: { amount_minor: 8000, currency: "USD" }
};

const slot: Slot = {
  id: "slot_1",
  schedule_id: "schedule_1",
  provider_id: "provider_1",
  service_id: "service_1",
  schedule_timezone: "America/Los_Angeles",
  // Canonical absolute instants (carry an offset). 10:00 / 11:00 America/
  // Los_Angeles in May (PDT, -7) are 17:00 / 18:00 UTC. The validator never
  // reads these for the wall-clock window check; they are present to prove the
  // instant fields are exempt from the no-offset rule.
  starts_at: "2026-05-02T17:00:00Z",
  ends_at: "2026-05-02T18:00:00Z",
  // Wall-clock fields the validator actually compares against the mandate.
  starts_at_local: "2026-05-02T10:00:00",
  ends_at_local: "2026-05-02T11:00:00"
};

describe("validateMandate", () => {
  it("accepts an in-scope booking create", () => {
    assert.deepEqual(
      validateMandate({
        mandate,
        action: "booking.create",
        organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
        service,
        slot,
        policy: { payment_requirement: "none" },
        now
      }),
      { ok: true }
    );
  });

  it("rejects naked wall-clock expires_at as invalid_mandate", () => {
    // expires_at is the canonical UTC-instant field; a wall-clock string
    // here parses as host-local under Date.parse and would silently shift
    // by hours when the host runs in a different tz from the merchant. See the
    // spec Time Discipline section.
    const result = validateMandate({
      mandate: { ...mandate, expires_at: "2026-05-01T13:00:00" },
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot,
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "invalid_mandate");
  });

  it("accepts expires_at with explicit non-Z offset", () => {
    // The live golden trace uses `-07:00` rather than `Z`; both are valid
    // tz-aware forms and the validator must accept either. Pinning this
    // so a regex tightening doesn't break the existing trace fixture.
    assert.deepEqual(
      validateMandate({
        mandate: { ...mandate, expires_at: "2026-05-01T13:00:00-07:00" },
        action: "booking.create",
        organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
        service,
        slot,
        policy: { payment_requirement: "none" },
        now
      }),
      { ok: true }
    );
  });

  it("rejects expired mandates", () => {
    const result = validateMandate({
      mandate: { ...mandate, expires_at: "2026-05-01T11:00:00Z" },
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot,
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "mandate_expired");
  });

  it("rejects out-of-scope provider", () => {
    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot: { ...slot, provider_id: "provider_2" },
      policy: { payment_requirement: "none" },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "provider_not_allowed");
  });

  it("rejects prices above scope", () => {
    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service: { ...service, price: { amount_minor: 12000, currency: "USD" } },
      slot,
      policy: { payment_requirement: "none" },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "price_exceeds_mandate");
  });

  it("rejects a price in a different currency than the mandate cap as currency_mismatch", () => {
    // OSBP must not convert currencies. A selected price whose currency differs
    // from the mandate cap fails closed for a new user approval rather than
    // comparing raw minor units across currencies. See the spec Money section.
    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service: { ...service, price: { amount_minor: 8000, currency: "EUR" } },
      slot,
      policy: { payment_requirement: "none" },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "currency_mismatch");
  });

  it("requires confirmation when the selected price has no fixed amount at booking time", () => {
    // A quote_required price carries a currency but no amount_minor, so the
    // mandate cap cannot bound it. Fail closed.
    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service: { ...service, price: { currency: "USD", type: "quote_required" } },
      slot,
      policy: { payment_requirement: "none" },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "requires_user_confirmation");
  });

  it("rejects a required fee in a different currency than max_extra_fee as currency_mismatch", () => {
    const result = validateMandate({
      mandate: {
        ...mandate,
        allow_policy_fee: true,
        max_extra_fee: { amount_minor: 2500, currency: "USD" }
      },
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot,
      policy: {
        service_id: "service_1",
        payment_requirement: "deposit",
        deposit: { amount_minor: 2000, currency: "EUR" }
      },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "currency_mismatch");
  });

  it("rejects a fee currency mismatch even when max_extra_fee omits an amount", () => {
    const result = validateMandate({
      mandate: {
        ...mandate,
        allow_policy_fee: true,
        max_extra_fee: { currency: "USD" }
      },
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot,
      policy: {
        service_id: "service_1",
        payment_requirement: "deposit",
        deposit: { amount_minor: 2000, currency: "EUR" }
      },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "currency_mismatch");
  });

  it("rejects a price currency mismatch even when max_price omits an amount", () => {
    const result = validateMandate({
      mandate: {
        ...mandate,
        max_price: { currency: "USD" }
      },
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service: { ...service, price: { amount_minor: 8000, currency: "EUR" } },
      slot,
      policy: { service_id: "service_1", payment_requirement: "none" },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "currency_mismatch");
  });

  it("treats an empty mandate scope array as allow-none, not allow-all", () => {
    const result = validateMandate({
      mandate: { ...mandate, service_ids: [] },
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot,
      policy: { service_id: "service_1", payment_requirement: "none" },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "service_not_allowed");
  });

  it("fails closed unconditionally on hasConsultation: true services", () => {
    // Consultation services drive a 4-step quote workflow
    // OSBP v0.1.0 cannot drive end-to-end. The validator rejects them
    // regardless of mandate fields (no allow_consultation opt-in in v0.1.0).
    // Asserts that the rejection fires before
    // any payment_requirement checks would.
    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service: { ...service, requires_consultation: true },
      slot,
      policy: { payment_requirement: "none" },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "requires_consultation_handoff");
  });

  it("fails closed on required deposits when fees are not allowed", () => {
    const policy: Policy = {
      service_id: "service_1",
      payment_requirement: "deposit",
      deposit: { amount_minor: 2000, currency: "USD" }
    };

    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot,
      policy,
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "requires_payment_handoff");
  });

  it("accepts required deposits inside explicit fee scope", () => {
    assert.deepEqual(
      validateMandate({
        mandate: {
          ...mandate,
          allow_policy_fee: true,
          max_extra_fee: { amount_minor: 2500, currency: "USD" }
        },
        action: "booking.create",
        organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
        service,
        slot,
        policy: {
          service_id: "service_1",
          payment_requirement: "deposit",
          deposit: { amount_minor: 2000, currency: "USD" }
        },
        now
      }),
      { ok: true }
    );
  });

  it("treats full_prepay as the service price for the required fee inside fee scope", () => {
    // For payment_requirement "full_prepay" the required fee is the service
    // price (8000), not the deposit. With fees allowed and max_extra_fee high
    // enough to cover the full price, the mandate accepts. Guards the
    // "full" -> "full_prepay" rename: the validator must route full_prepay to
    // service.price.
    assert.deepEqual(
      validateMandate({
        mandate: {
          ...mandate,
          allow_policy_fee: true,
          max_extra_fee: { amount_minor: 8000, currency: "USD" }
        },
        action: "booking.create",
        organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
        service,
        slot,
        policy: {
          service_id: "service_1",
          payment_requirement: "full_prepay"
        },
        now
      }),
      { ok: true }
    );
  });

  it("rejects a full_prepay service price above max_extra_fee as policy_fee_exceeds_mandate", () => {
    const result = validateMandate({
      mandate: {
        ...mandate,
        allow_policy_fee: true,
        max_extra_fee: { amount_minor: 5000, currency: "USD" }
      },
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot,
      policy: {
        service_id: "service_1",
        payment_requirement: "full_prepay"
      },
      now
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "policy_fee_exceeds_mandate");
  });

  // validateSlotScope must reject any tz-aware input on the four
  // wall-clock fields so compareDateLike never silently shifts by the host's
  // tz. Mirror of the instant-side strictness on expires_at, inverse
  // assertion. Each case mutates exactly one of the four fields to a
  // tz-aware value and confirms the rejection fires before any
  // schedule/provider/time scope check.
  const wallClockOffsetCases: ReadonlyArray<{
    field: string;
    tzAware: string;
    apply: (params: { mandate: BookingMandate; slot: Slot }) => { mandate: BookingMandate; slot: Slot };
  }> = [
    {
      field: "BookingMandate.earliest_start",
      tzAware: "2026-05-02T09:00:00Z",
      apply: ({ mandate: m, slot: s }) => ({ mandate: { ...m, earliest_start: "2026-05-02T09:00:00Z" }, slot: s })
    },
    {
      field: "BookingMandate.latest_end",
      tzAware: "2026-05-02T18:00:00-07:00",
      apply: ({ mandate: m, slot: s }) => ({ mandate: { ...m, latest_end: "2026-05-02T18:00:00-07:00" }, slot: s })
    },
    {
      field: "Slot.starts_at_local",
      tzAware: "2026-05-02T10:00:00Z",
      apply: ({ mandate: m, slot: s }) => ({ mandate: m, slot: { ...s, starts_at_local: "2026-05-02T10:00:00Z" } })
    },
    {
      field: "Slot.ends_at_local",
      tzAware: "2026-05-02T11:00:00+00:00",
      apply: ({ mandate: m, slot: s }) => ({ mandate: m, slot: { ...s, ends_at_local: "2026-05-02T11:00:00+00:00" } })
    }
  ];

  for (const { field, tzAware, apply } of wallClockOffsetCases) {
    it(`rejects tz-aware ${field} (${tzAware}) as invalid_mandate`, () => {
      const { mandate: m, slot: s } = apply({ mandate, slot });
      const result = validateMandate({
        mandate: m,
        action: "booking.create",
        organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
        service,
        slot: s,
        policy: { payment_requirement: "none" },
        now
      });

      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.problem.code, "invalid_mandate");
      assert.match(
        result.ok ? "" : result.problem.message,
        new RegExp(field.replace(/\./g, "\\."))
      );
    });
  }

  it("does not reject offset-carrying Slot.starts_at / ends_at (the instant fields are exempt)", () => {
    // The wall-clock no-offset rule applies to starts_at_local / ends_at_local,
    // NOT to the canonical absolute instants starts_at / ends_at, which MUST
    // carry an offset. A slot whose instants carry `Z` while its wall-clock
    // fields stay offset-free must still validate cleanly. Inverse of the
    // parametrized rejection cases above.
    assert.deepEqual(
      validateMandate({
        mandate,
        action: "booking.create",
        organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
        service,
        slot: {
          ...slot,
          starts_at: "2026-05-02T17:00:00Z",
          ends_at: "2026-05-02T18:00:00Z",
          starts_at_local: "2026-05-02T10:00:00",
          ends_at_local: "2026-05-02T11:00:00"
        },
        policy: { payment_requirement: "none" },
        now
      }),
      { ok: true }
    );
  });

  it("rejects an offset-carrying earliest_start while accepting a slot inside the window by local time", () => {
    // Belt-and-suspenders for the wall-clock side: a tz-aware earliest_start is
    // invalid_mandate, but with a clean wall-clock window the same slot (whose
    // wall-clock 10:00 sits inside 09:00..18:00) validates. Proves the renamed
    // wall-clock comparison reads starts_at_local, not the instant.
    const rejected = validateMandate({
      mandate: { ...mandate, earliest_start: "2026-05-02T09:00:00-07:00" },
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot,
      policy: { payment_requirement: "none" },
      now
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok ? undefined : rejected.problem.code, "invalid_mandate");

    const accepted = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      service,
      slot,
      policy: { payment_requirement: "none" },
      now
    });
    assert.deepEqual(accepted, { ok: true });
  });
});

describe("validateMandate fail-closed hardening", () => {
  const accept = {
    mandate,
    action: "booking.create" as const,
    organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
    service,
    slot,
    policy: { payment_requirement: "none" } as Policy,
    now
  };

  it("rejects a numeric max_price cap when no service or slot price is present", () => {
    // A priced cap that cannot be bound by any fixed price is unbounded
    // authority. The fee path already fails closed here; the price path must too.
    const result = validateMandate({
      ...accept,
      service: { id: "service_1", name: "Haircut" },
      slot: { ...slot, price: undefined }
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "requires_user_confirmation");
  });

  it("rejects a currency-only max_price cap as unbounded for booking.create", () => {
    const result = validateMandate({
      ...accept,
      mandate: { ...mandate, max_price: { currency: "USD" } },
      service: { ...service, price: { amount_minor: 8000, currency: "USD" } }
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "requires_user_confirmation");
  });

  it("rejects booking.create with no policy evidence", () => {
    const { policy: _policy, ...withoutPolicy } = accept;
    const result = validateMandate(withoutPolicy);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "invalid_mandate");
  });

  it("rejects booking.create with no slot evidence", () => {
    const { slot: _slot, ...withoutSlot } = accept;
    const result = validateMandate(withoutSlot);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "invalid_mandate");
  });

  it("rejects evidence describing different services", () => {
    const result = validateMandate({ ...accept, slot: { ...slot, service_id: "service_2" } });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "invalid_mandate");
  });

  it("rejects a string mandate scope instead of substring-matching it", () => {
    // A scope arriving as a bare string (not string[]) silently becomes
    // String.prototype.includes substring matching: "service_1" would admit
    // "service_12". Reject the shape at the trust boundary.
    const result = validateMandate({
      ...accept,
      mandate: { ...mandate, service_ids: "service_1" } as unknown as BookingMandate
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "invalid_mandate");
  });

  it("rejects a non-array allowed_actions instead of throwing", () => {
    const result = validateMandate({
      ...accept,
      mandate: { ...mandate, allowed_actions: undefined } as unknown as BookingMandate
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "invalid_mandate");
  });

  it("rejects an unparseable wall-clock slot time instead of lexical comparison", () => {
    const result = validateMandate({ ...accept, slot: { ...slot, starts_at_local: "tomorrow" } });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "invalid_mandate");
  });

  it("rejects a date-only mandate window bound", () => {
    const result = validateMandate({ ...accept, mandate: { ...mandate, earliest_start: "2026-05-02" } });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "invalid_mandate");
  });
});

describe("validateMandate reject paths (previously unexercised)", () => {
  const org = "org_01jw3z8x9k2m4n6p8r0s1t3v5w";
  const policy: Policy = { payment_requirement: "none" };

  it("rejects an action outside allowed_actions", () => {
    const result = validateMandate({ mandate, action: "booking.status", organization_id: org, now });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "action_not_allowed");
  });

  it("rejects an organization outside mandate scope", () => {
    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w0other",
      service,
      slot,
      policy,
      now
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "organization_not_allowed");
  });

  it("rejects a schedule outside mandate scope", () => {
    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: org,
      service,
      slot: { ...slot, schedule_id: "schedule_2" },
      policy,
      now
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "schedule_not_allowed");
  });

  it("rejects a slot starting before earliest_start", () => {
    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: org,
      service,
      slot: { ...slot, starts_at_local: "2026-05-02T08:00:00", ends_at_local: "2026-05-02T08:30:00" },
      policy,
      now
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "slot_too_early");
  });

  it("rejects a slot ending after latest_end", () => {
    const result = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: org,
      service,
      slot: { ...slot, starts_at_local: "2026-05-02T17:00:00", ends_at_local: "2026-05-02T19:00:00" },
      policy,
      now
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "slot_too_late");
  });
});
