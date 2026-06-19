import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AdapterResult, BookingCreateInput, BookingMandate, Money, Receipt, Service, Slot } from "@osbp/core";
import {
  REFERENCE_CONFORMANCE_FIXTURES,
  REFERENCE_CONFORMANCE_ORGANIZATION,
  REFERENCE_ORGANIZATIONS,
  SyntheticBookingAdapter,
  runReadOnlySmoke,
  startSyntheticBookingServer,
  wallClockToInstant,
  type ReferenceOrganizationSeed,
  type SyntheticBookingServer
} from "./index.js";
import { GUM_BLOCK_SEPARATOR, renderReferenceDemo } from "./demo.js";

interface OrgFixture {
  id: string;
  happyServiceId: string;
  consultationServiceId: string;
  paymentServiceId: string;
  nonFixedServiceId: string;
  unknownPaymentServiceId: string;
  defaultScheduleId: string;
  onlineScheduleId?: string;
}

const ORG_FIXTURES: OrgFixture[] = [
  {
    id: "org_01jz7ay6r8dd6yskkpt8rvhk8z",
    happyServiceId: "dental_cleaning",
    consultationServiceId: "dental_new_patient_exam",
    paymentServiceId: "dental_crown",
    nonFixedServiceId: "dental_filling",
    unknownPaymentServiceId: "dental_custom_treatment_plan",
    defaultScheduleId: "dental_midtown"
  },
  {
    id: "org_01jz7gmphxn33ertpvvx9y3yfh",
    happyServiceId: "notary_document",
    consultationServiceId: "notary_complex_document_review",
    paymentServiceId: "notary_closing_package",
    nonFixedServiceId: "notary_apostille",
    unknownPaymentServiceId: "notary_custom_filing",
    defaultScheduleId: "notary_office",
    onlineScheduleId: "notary_online"
  },
  {
    id: "org_01jz7jevggr5st9acrxfbexvzz",
    happyServiceId: "auto_oil_change",
    consultationServiceId: "auto_check_engine_diagnosis",
    paymentServiceId: "auto_major_repair",
    nonFixedServiceId: "auto_custom_repair_quote",
    unknownPaymentServiceId: "auto_special_order_part",
    defaultScheduleId: "auto_berlin_shop"
  },
  {
    id: "org_01jz731qszrrnysfpdypv1kkv7",
    happyServiceId: "spa_swedish_massage",
    consultationServiceId: "spa_skin_consultation",
    paymentServiceId: "spa_couples_day_package",
    nonFixedServiceId: "spa_custom_wellness_package",
    unknownPaymentServiceId: "spa_private_event",
    defaultScheduleId: "spa_soho"
  }
];

describe("SyntheticBookingAdapter", { concurrency: false }, () => {
  it("read-only smoke passes for every seeded organization", async () => {
    await withServer(async (server) => {
      for (const fixture of ORG_FIXTURES) {
        const adapter = adapterFor(server, fixture.id);

        const result = await runReadOnlySmoke(adapter);

        assert.equal(result.ok, true, fixture.id);
        if (!result.ok) continue;
        assert.equal(result.value.organization.id, fixture.id);
        assert.ok(result.value.services.length >= 6);
        assert.ok(result.value.locations.length >= 1);
        assert.ok(result.value.slots.length >= 1);
        assert.equal(result.value.checks.mandate_reachability.passed, true);
        assert.equal(result.value.checks.happy_path_bookability.passed, true);
      }
    });
  });

  it("keeps verification opt-in per service for the default demo seed", () => {
    for (const organization of REFERENCE_ORGANIZATIONS) {
      for (const service of organization.services) {
        assert.equal(
          service.policy.verification_method,
          "none",
          `${organization.id}:${service.id}`
        );
      }
    }
  });

  it("captures the ideal platform metadata set, with a Deprecation/Sunset example", async () => {
    // The reference backend is the IDEAL platform: every response carries
    // server, api-version, a unique request-id, and RateLimit headers, and the
    // availability read additionally carries Deprecation (RFC 9745) and Sunset
    // (RFC 8594). The adapter captures the full set into UpstreamMeta, OSBP's
    // audit drift-provenance channel, which a minimal real-platform API cannot
    // exercise live.
    await withServer(async (server) => {
      const fixture = ORG_FIXTURES[0];
      assert.ok(fixture);
      const adapter = adapterFor(server, fixture.id);

      await adapter.describeService({ service_id: fixture.happyServiceId });
      const baseline = adapter.upstreamMeta;
      assert.ok(baseline, "describeService captures upstream metadata");
      assert.equal(baseline?.api_version, "2026-06-13");
      assert.ok(baseline?.server);
      assert.ok(baseline?.request_id);
      assert.ok(baseline?.ratelimit?.["ratelimit"]);
      assert.equal(baseline?.deprecation, undefined, "a non-deprecated read carries no Deprecation header");

      const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      await adapter.findAvailability({
        service_id: fixture.happyServiceId,
        schedule_id: fixture.defaultScheduleId,
        date
      });
      const availability = adapter.upstreamMeta;
      assert.ok(availability?.deprecation, "the availability read demonstrates the Deprecation header");
      assert.ok(availability?.sunset, "the availability read demonstrates the Sunset header");
      assert.ok(availability?.request_id);
      assert.notEqual(availability?.request_id, baseline?.request_id, "each response carries a unique request-id");
    });
  });

  it("creates a happy-path booking, returns a receipt, and reads status for every organization", async () => {
    await withServer(async (server) => {
      for (const fixture of ORG_FIXTURES) {
        const adapter = adapterFor(server, fixture.id);
        const input = await createInputFor(adapter, fixture, fixture.happyServiceId, `happy-${fixture.id}`);

        const receipt = await confirmAndBook(adapter, input);

        assert.equal(receipt.ok, true, fixture.id);
        if (!receipt.ok) continue;
        assert.match(receipt.value.text, /Booked /);
        assert.ok(receipt.value.booking_id);

        const status = await adapter.getBooking({ booking_id: receipt.value.booking_id });

        assert.equal(status.ok, true, fixture.id);
        if (!status.ok) continue;
        assert.equal(status.value.status, "booked");
        assert.equal(status.value.service_id, fixture.happyServiceId);
        assert.equal(status.value.schedule_id, input.schedule_id);
        assert.equal(status.value.provider_id, input.provider_id);
        assert.equal(status.value.starts_at_local, `${input.date}T${input.time}:00`);
        assert.ok(status.value.starts_at);
      }
    });
  });

  it("returns exact mandate fail-closed problem codes for every organization", async () => {
    await withServer(async (server) => {
      for (const fixture of ORG_FIXTURES) {
        const adapter = adapterFor(server, fixture.id);

        const cases: Array<{
          name: string;
          serviceId: string;
          expectedCode: string;
          mutate?: (input: BookingCreateInput) => BookingCreateInput;
        }> = [
          {
            name: "consultation",
            serviceId: fixture.consultationServiceId,
            expectedCode: "requires_consultation_handoff"
          },
          {
            name: "required payment",
            serviceId: fixture.paymentServiceId,
            expectedCode: "requires_payment_handoff"
          },
          {
            name: "non-fixed price",
            serviceId: fixture.nonFixedServiceId,
            expectedCode: "requires_user_confirmation"
          },
          {
            name: "unknown payment",
            serviceId: fixture.unknownPaymentServiceId,
            expectedCode: "requires_user_confirmation"
          },
          {
            name: "currency mismatch",
            serviceId: fixture.happyServiceId,
            expectedCode: "currency_mismatch",
            mutate: (input) => withMandate(input, {
              max_price: {
                amount_minor: input.mandate.max_price?.amount_minor ?? 1,
                currency: input.mandate.max_price?.currency === "USD" ? "EUR" : "USD"
              }
            })
          },
          {
            name: "price exceeds mandate",
            serviceId: fixture.happyServiceId,
            expectedCode: "price_exceeds_mandate",
            mutate: (input) => withMandate(input, {
              max_price: {
                amount_minor: Math.max(0, (input.mandate.max_price?.amount_minor ?? 1) - 1),
                currency: input.mandate.max_price?.currency ?? "USD"
              }
            })
          },
          {
            name: "provider not allowed",
            serviceId: fixture.happyServiceId,
            expectedCode: "provider_not_allowed",
            mutate: (input) => withMandate(input, { provider_ids: ["provider_not_allowed"] })
          },
          {
            name: "schedule not allowed",
            serviceId: fixture.happyServiceId,
            expectedCode: "schedule_not_allowed",
            mutate: (input) => withMandate(input, { schedule_ids: ["schedule_not_allowed"] })
          },
          {
            name: "service not allowed",
            serviceId: fixture.happyServiceId,
            expectedCode: "service_not_allowed",
            mutate: (input) => withMandate(input, { service_ids: ["service_not_allowed"] })
          },
          {
            name: "organization not allowed",
            serviceId: fixture.happyServiceId,
            expectedCode: "organization_not_allowed",
            mutate: (input) => withMandate(input, { organization_id: "other_org" })
          },
          {
            name: "action not allowed",
            serviceId: fixture.happyServiceId,
            expectedCode: "action_not_allowed",
            mutate: (input) => withMandate(input, { allowed_actions: ["booking.status"] })
          },
          {
            name: "expired mandate",
            serviceId: fixture.happyServiceId,
            expectedCode: "mandate_expired",
            mutate: (input) => withMandate(input, { expires_at: "2020-01-01T00:00:00Z" })
          },
          {
            name: "slot too early",
            serviceId: fixture.happyServiceId,
            expectedCode: "slot_too_early",
            mutate: (input) => withMandate(input, { earliest_start: `${input.date}T23:59:00` })
          },
          {
            name: "slot too late",
            serviceId: fixture.happyServiceId,
            expectedCode: "slot_too_late",
            mutate: (input) => withMandate(input, { latest_end: `${input.date}T00:01:00` })
          }
        ];

        for (const testCase of cases) {
          const baseInput = await createInputFor(
            adapter,
            fixture,
            testCase.serviceId,
            `${fixture.id}-${testCase.name.replaceAll(" ", "-")}`
          );
          const input = testCase.mutate ? testCase.mutate(baseInput) : baseInput;

          const result = await adapter.createBooking(input);

          assert.equal(
            result.ok ? undefined : result.problem.code,
            testCase.expectedCode,
            `${fixture.id}: ${testCase.name}`
          );
        }
      }
    });
  });

  it("returns exact runtime problem codes and completes the verification retry for every organization", async () => {
    await withServer(async (server) => {
      for (const fixture of ORG_FIXTURES) {
        const adapter = adapterFor(server, fixture.id);

        await armScenario(server, fixture.id, "slot_taken");
        const slotTaken = await confirmAndBook(
          adapter,
          await createInputFor(adapter, fixture, fixture.happyServiceId, `slot-taken-${fixture.id}`)
        );
        assert.equal(slotTaken.ok ? undefined : slotTaken.problem.code, "slot_taken", fixture.id);

        await armScenario(server, fixture.id, "rate_limited");
        const rateLimited = await confirmAndBook(
          adapter,
          await createInputFor(adapter, fixture, fixture.happyServiceId, `rate-limited-${fixture.id}`)
        );
        assert.equal(rateLimited.ok ? undefined : rateLimited.problem.code, "rate_limited", fixture.id);
        assert.equal(rateLimited.ok ? undefined : rateLimited.problem.retryable, true, fixture.id);

        const verificationInput = await createInputFor(
          adapter,
          fixture,
          fixture.happyServiceId,
          `verification-${fixture.id}`
        );
        await armScenario(server, fixture.id, "requires_verification");
        const approvedVerification = await approvedInput(adapter, verificationInput);
        const needsVerification = await adapter.createBooking(approvedVerification);
        assert.equal(
          needsVerification.ok ? undefined : needsVerification.problem.code,
          "requires_verification",
          fixture.id
        );

        const sent = await adapter.sendVerification({
          customer: verificationInput.customer,
          purpose: `booking:${fixture.id}`
        });
        assert.equal(sent.ok, true, fixture.id);
        assert.equal(sent.ok ? sent.value.method : undefined, "sms");

        const verified = await adapter.verifyCode({
          customer: verificationInput.customer,
          purpose: `booking:${fixture.id}`,
          code: "123456"
        });
        assert.equal(verified.ok, true, fixture.id);
        assert.equal(verified.ok ? verified.value.verified : undefined, true);

        const retry = await adapter.createBooking({
          ...approvedVerification,
          verification_code: "123456"
        });
        assert.equal(retry.ok, true, fixture.id);
      }
    });
  });

  it("requires verification from service policy without arming a test scenario", async () => {
    const server = await startSyntheticBookingServer([POLICY_VERIFICATION_ORGANIZATION]);
    try {
      const fixture: OrgFixture = {
        id: POLICY_VERIFICATION_ORGANIZATION.id,
        happyServiceId: "policy_sms_booking",
        consultationServiceId: "policy_sms_booking",
        paymentServiceId: "policy_sms_booking",
        nonFixedServiceId: "policy_sms_booking",
        unknownPaymentServiceId: "policy_sms_booking",
        defaultScheduleId: "policy_front_desk"
      };
      const adapter = adapterFor(server, fixture.id);
      const input = await createInputFor(adapter, fixture, fixture.happyServiceId, "policy-verification");

      const approved = await approvedInput(adapter, input);
      const initial = await adapter.createBooking(approved);

      assert.equal(initial.ok ? undefined : initial.problem.code, "requires_verification");

      const sent = await adapter.sendVerification({
        customer: input.customer,
        purpose: `booking:${fixture.id}`
      });
      assert.equal(sent.ok, true);

      const verified = await adapter.verifyCode({
        customer: input.customer,
        purpose: `booking:${fixture.id}`,
        code: "123456"
      });
      assert.equal(verified.ok, true);

      const retry = await adapter.createBooking({
        ...approved,
        verification_code: "123456"
      });
      assert.equal(retry.ok, true);
    } finally {
      await server.close();
    }
  });

  it("keeps online notary slots as peer schedule results without address or customer-timezone fallback", async () => {
    await withServer(async (server) => {
      const fixture = ORG_FIXTURES.find((candidate) => candidate.id === "org_01jz7gmphxn33ertpvvx9y3yfh");
      assert.ok(fixture?.onlineScheduleId);
      const adapter = adapterFor(server, fixture.id);
      const date = futureDateIso(5);

      const inPerson = await adapter.findAvailability({
        service_id: fixture.happyServiceId,
        schedule_id: fixture.defaultScheduleId,
        date
      });
      const online = await adapter.findAvailability({
        service_id: fixture.happyServiceId,
        schedule_id: fixture.onlineScheduleId,
        date
      });

      assert.equal(inPerson.ok, true);
      assert.equal(online.ok, true);
      if (!inPerson.ok || !online.ok) return;
      assert.equal(inPerson.value[0]?.service_id, fixture.happyServiceId);
      assert.equal(online.value[0]?.service_id, fixture.happyServiceId);
      assert.equal(inPerson.value[0]?.schedule_address, "11 W 42nd St, New York, NY 10036");
      assert.equal(online.value[0]?.schedule_name, "Online (remote notarization)");
      assert.equal("schedule_address" in online.value[0], false);
      assert.equal("schedule_latitude" in online.value[0], false);
      assert.equal("schedule_longitude" in online.value[0], false);
      assert.equal(online.value[0]?.schedule_timezone, "America/New_York");
      assert.match(online.value[0]?.starts_at ?? "", /Z$|[+-]\d{2}:?\d{2}$/);
      assert.ok(Number.isFinite(Date.parse(online.value[0]?.starts_at ?? "")));

      const inPersonBooking = await confirmAndBook(
        adapter,
        await createInputFor(adapter, fixture, fixture.happyServiceId, "notary-in-person", fixture.defaultScheduleId)
      );
      const onlineBooking = await confirmAndBook(
        adapter,
        await createInputFor(adapter, fixture, fixture.happyServiceId, "notary-online", fixture.onlineScheduleId)
      );

      assert.equal(inPersonBooking.ok, true);
      assert.equal(onlineBooking.ok, true);
      assert.notEqual(
        inPersonBooking.ok ? inPersonBooking.value.booking_id : undefined,
        onlineBooking.ok ? onlineBooking.value.booking_id : undefined
      );
    });
  });

  it("keeps provider-specific slot times stable when availability is provider-filtered", async () => {
    await withServer(async (server) => {
      const fixture = ORG_FIXTURES.find((candidate) => candidate.id === "org_01jz7gmphxn33ertpvvx9y3yfh");
      assert.ok(fixture);
      const adapter = adapterFor(server, fixture.id);
      const date = futureDateIso(6);

      const unfiltered = await adapter.findAvailability({
        service_id: fixture.happyServiceId,
        schedule_id: fixture.defaultScheduleId,
        date
      });
      assert.equal(unfiltered.ok, true);
      if (!unfiltered.ok) return;
      const providerSlot = unfiltered.value.find((slot) => slot.provider_id === "notary_patel");
      assert.ok(providerSlot);

      const filtered = await adapter.findAvailability({
        service_id: fixture.happyServiceId,
        schedule_id: fixture.defaultScheduleId,
        provider_id: "notary_patel",
        date
      });

      assert.equal(filtered.ok, true);
      if (!filtered.ok) return;
      assert.equal(filtered.value[0]?.starts_at_local, providerSlot.starts_at_local);
    });
  });

  it("replays matching idempotency keys and rejects conflicting payloads locally", async () => {
    await withServer(async (server) => {
      const fixture = ORG_FIXTURES[0];
      assert.ok(fixture);
      const adapter = adapterFor(server, fixture.id);
      const input = await createInputFor(adapter, fixture, fixture.happyServiceId, "idempotency");

      const first = await confirmAndBook(adapter, input);
      const replay = await adapter.createBooking(input);
      const conflict = await adapter.createBooking({
        ...input,
        time: "15:00"
      });

      assert.equal(first.ok, true);
      assert.equal(replay.ok, true);
      assert.deepEqual(replay, first);
      assert.equal(conflict.ok ? undefined : conflict.problem.code, "idempotency_conflict");
    });
  });

  it("derives DST-correct RFC 3339 instants from merchant-local wall-clock values", () => {
    assert.equal(wallClockToInstant("2030-01-15T09:00:00", "America/New_York"), "2030-01-15T14:00:00.000Z");
    assert.equal(wallClockToInstant("2030-07-15T09:00:00", "America/New_York"), "2030-07-15T13:00:00.000Z");
    assert.equal(wallClockToInstant("2030-01-15T09:00:00", "Europe/Berlin"), "2030-01-15T08:00:00.000Z");
    assert.equal(wallClockToInstant("2030-07-15T09:00:00", "Europe/Berlin"), "2030-07-15T07:00:00.000Z");
    assert.equal(wallClockToInstant("2030-01-15T09:00:00", "Europe/London"), "2030-01-15T09:00:00.000Z");
    assert.equal(wallClockToInstant("2030-07-15T09:00:00", "Europe/London"), "2030-07-15T08:00:00.000Z");
  });

  it("defines four unrelated verticals as seed data, not adapter subclasses", () => {
    const byId = new Map(REFERENCE_ORGANIZATIONS.map((organization) => [organization.id, organization]));

    assert.deepEqual([...byId.keys()].sort(), ORG_FIXTURES.map((fixture) => fixture.id).sort());
    assertSeedLooksLikeVertical(byId.get("org_01jz7ay6r8dd6yskkpt8rvhk8z"), "Carolyn's Dental", "USD", "America/New_York");
    assertSeedLooksLikeVertical(byId.get("org_01jz7gmphxn33ertpvvx9y3yfh"), "Gus' Notary", "USD", "America/New_York");
    assertSeedLooksLikeVertical(byId.get("org_01jz7jevggr5st9acrxfbexvzz"), "Andy's Auto", "EUR", "Europe/Berlin");
    assertSeedLooksLikeVertical(byId.get("org_01jz731qszrrnysfpdypv1kkv7"), "Phil's Spa", "GBP", "Europe/London");
  });

  it("covers a zero-decimal ISO 4217 money exponent in the seed data", () => {
    const spa = REFERENCE_ORGANIZATIONS.find((organization) => organization.id === "org_01jz731qszrrnysfpdypv1kkv7");
    const giftExperience = spa?.services.find((service) => service.id === "spa_gift_experience_jpy");

    assert.equal(giftExperience?.price.amount_minor, 12000);
    assert.equal(giftExperience?.price.currency, "JPY");
    assert.equal(giftExperience?.price.display, "¥12,000");
  });

  it("exports a multi-currency conformance fixture outside the default demo seed", () => {
    assert.equal(
      REFERENCE_ORGANIZATIONS.some((organization) => organization.id === REFERENCE_CONFORMANCE_ORGANIZATION.id),
      false
    );
    assert.equal(REFERENCE_CONFORMANCE_ORGANIZATION.id, REFERENCE_CONFORMANCE_FIXTURES.organization_id);
    assert.equal(REFERENCE_CONFORMANCE_ORGANIZATION.allow_parallel_bookings, true);
    assert.equal(REFERENCE_CONFORMANCE_ORGANIZATION.locations[0]?.id, REFERENCE_CONFORMANCE_FIXTURES.schedule_id);
    assert.equal(
      REFERENCE_CONFORMANCE_ORGANIZATION.providers.some((provider) => provider.id === REFERENCE_CONFORMANCE_FIXTURES.provider_id),
      true
    );

    const services = new Map(REFERENCE_CONFORMANCE_ORGANIZATION.services.map((service) => [service.id, service]));
    assert.equal(services.size, Object.keys(REFERENCE_CONFORMANCE_FIXTURES.services).length);
    for (const serviceId of Object.values(REFERENCE_CONFORMANCE_FIXTURES.services)) {
      assert.ok(services.has(serviceId), serviceId);
    }

    assert.deepEqual(REFERENCE_CONFORMANCE_FIXTURES.expected_prices, {
      conformance_fixed_usd: { amount_minor: 9500, currency: "USD" },
      conformance_fixed_eur: { amount_minor: 9000, currency: "EUR" },
      conformance_fixed_gbp: { amount_minor: 8000, currency: "GBP" },
      conformance_fixed_jpy: { amount_minor: 12000, currency: "JPY" },
      conformance_fixed_kwd: { amount_minor: 12500, currency: "KWD" }
    });
    assert.equal(services.get(REFERENCE_CONFORMANCE_FIXTURES.services.fixed_jpy)?.price.display, "¥12,000");
    assert.equal(services.get(REFERENCE_CONFORMANCE_FIXTURES.services.fixed_usd)?.options?.[0]?.duration, "PT15M");
    assert.equal(services.get(REFERENCE_CONFORMANCE_FIXTURES.services.insurance_dependent)?.price.amount_minor, undefined);
    assert.equal(services.get(REFERENCE_CONFORMANCE_FIXTURES.services.quote_required)?.price.amount_minor, undefined);
    assert.equal(services.get(REFERENCE_CONFORMANCE_FIXTURES.services.consultation)?.requires_consultation, true);
    assert.equal(services.get(REFERENCE_CONFORMANCE_FIXTURES.services.deposit)?.policy.payment_requirement, "deposit");
    assert.equal(services.get(REFERENCE_CONFORMANCE_FIXTURES.services.full_prepay)?.policy.payment_requirement, "full_prepay");
    assert.equal(services.get(REFERENCE_CONFORMANCE_FIXTURES.services.unknown_payment)?.policy.payment_requirement, "unknown");
    assert.equal(services.get(REFERENCE_CONFORMANCE_FIXTURES.services.verification)?.policy.verification_method, "sms");
  });

  it("renders a deterministic narrated demo with four bookings and an over-cap coda", () => {
    const args = ["--demo", "--now", "2026-07-01T09:00:00Z"];

    const first = runCli(args);
    const second = runCli(args);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.match(first.stdout, /Carolyn's Dental/);
    assert.match(first.stdout, /Andy's Auto/);
    assert.match(first.stdout, /Gus' Notary/);
    assert.match(first.stdout, /Phil's Spa/);
    assert.equal(matchCount(first.stdout, /Server authorization gate: PASS/g), 4);
    assert.equal(matchCount(first.stdout, /booking\.create/g), 4);
    assert.match(first.stdout, /Server authorization gate: REJECT/);
    assert.match(first.stdout, /price_exceeds_mandate/);
    assert.match(first.stdout, /validateMandate\(\)/);

    const simulatedPast = runCli(["--demo", "--vertical", "dental", "--now", "2020-01-01T09:00:00Z"]);
    assert.equal(simulatedPast.status, 0, simulatedPast.stderr);
    assert.match(simulatedPast.stdout, /Server authorization gate: PASS/);
    assert.match(simulatedPast.stdout, /Receipt:/);
  });

  it("renders a compact launch tape mode as short readable cards", () => {
    const result = runCli(["--demo", "--launch", "--tape", "--now", "2026-07-01T09:00:00Z"]);

    assert.equal(result.status, 0, result.stderr);
    const cards = result.stdout.split("\f");
    assert.equal(cards.length, 5);
    assert.match(result.stdout, /INTENT/);
    assert.match(result.stdout, /MANDATE/);
    assert.match(result.stdout, /LOOK/);
    assert.match(result.stdout, /SERVER AUTHORIZATION GATE/);
    assert.match(result.stdout, /PASS/);
    assert.match(result.stdout, /REJECT/);
    assert.match(result.stdout, /price_exceeds_mandate/);
    assert.match(result.stdout, /NO BOOKING CREATED/);
    assert.equal(matchCount(result.stdout, /booking\.create/g), 1);

    for (const line of result.stdout.split(/\r?\n/)) {
      assert.ok(stripAnsi(line).length <= 72, line);
    }

    const scrolled = runCli([
      "--demo",
      "--launch",
      "--tape",
      "--now",
      "2026-07-01T09:00:00Z",
      "--card-ms",
      "0",
      "--type-ms",
      "0"
    ]);
    assert.equal(scrolled.status, 0, scrolled.stderr);
    assert.doesNotMatch(scrolled.stdout, /\f/);
    assert.doesNotMatch(scrolled.stdout, /\x1b\[2J|\x1b\[H/);
    assert.match(
      scrolled.stdout,
      /osbp service\.describe[\s\S]*osbp availability\.find[\s\S]*osbp policy\.explain/
    );
    assert.match(scrolled.stdout, /osbp booking\.create[\s\S]*NO BOOKING CREATED/);
    assert.match(scrolled.stdout, /OSBP REFERENCE DEMO[\s\S]*LOOK[\s\S]*BOOK[\s\S]*NO BOOKING CREATED/);
  });
});

describe("renderReferenceDemo", { concurrency: false }, () => {
  const now = new Date("2026-07-01T09:00:00Z");

  it("renders every vertical plus the fail-closed coda by default", async () => {
    const output = await renderReferenceDemo({ now });
    assert.match(output, /OSBP reference-backend demo/);
    assert.match(output, /Fail-closed coda/);
  });

  it("renders a single selected vertical without the coda", async () => {
    const output = await renderReferenceDemo({ now, vertical: "spa" });
    assert.match(output, /Phil's Spa/);
    assert.doesNotMatch(output, /Fail-closed coda/);
  });

  it("renders the compact launch tape", async () => {
    const output = await renderReferenceDemo({ now, tape: true });
    assert.match(output, /OSBP REFERENCE DEMO/);
    assert.match(output, /MANDATE/);
  });

  it("renders gum-block tape segments without invoking the gum binary", async () => {
    const output = await renderReferenceDemo({ now, tape: true, gum: true });
    assert.ok(output.includes(GUM_BLOCK_SEPARATOR), "gum tape should use the block separator");
    assert.match(output, /OPENING/);
    assert.match(output, /Version: v0\.1\.0/);
  });

  it("renders the launch narration variant", async () => {
    const output = await renderReferenceDemo({ now, launch: true });
    assert.match(output, /OSBP reference-backend demo/);
  });

  it("rejects an unknown vertical", async () => {
    await assert.rejects(renderReferenceDemo({ now, vertical: "nope" }), /Unknown demo vertical/);
  });
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./cli.js", import.meta.url)), ...args], {
    encoding: "utf8"
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function matchCount(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

async function withServer(run: (server: SyntheticBookingServer) => Promise<void>): Promise<void> {
  const server = await startSyntheticBookingServer();
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

const POLICY_VERIFICATION_ORGANIZATION: ReferenceOrganizationSeed = {
  id: "policy_verification_co",
  name: "Policy Verification Co",
  slug: "policy-verification-co",
  country: "US",
  currency: "USD",
  timezone: "America/New_York",
  domain: "policy-verification.example",
  phone: "+12125550199",
  support_email: "support@policy-verification.example",
  locations: [
    {
      id: "policy_front_desk",
      name: "Policy Front Desk",
      slug: "policy-front-desk",
      address: "1 Verification Way, New York, NY 10001",
      timezone: "America/New_York",
      latitude: 40.75,
      longitude: -73.99,
      hours: [
        { day: 1, open: "09:00", close: "17:00" }
      ]
    }
  ],
  providers: [
    { id: "policy_provider", name: "Pat Policy", schedule_ids: ["policy_front_desk"] }
  ],
  services: [
    {
      id: "policy_sms_booking",
      name: "SMS-gated booking",
      duration: "PT30M",
      price: {
        amount_minor: 2500,
        currency: "USD",
        type: "fixed",
        display: "$25.00"
      },
      branch: "policy-driven verification",
      schedule_ids: ["policy_front_desk"],
      provider_ids: ["policy_provider"],
      policy: {
        cancellation_enabled: true,
        cancellation_window: "PT24H",
        cancellation_note: "Cancel at least 24 hours before the appointment.",
        late_grace: "PT15M",
        payment_requirement: "none",
        verification_method: "sms"
      }
    }
  ]
};

async function confirmAndBook(
  adapter: SyntheticBookingAdapter,
  input: BookingCreateInput
): Promise<AdapterResult<Receipt>> {
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

async function approvedInput(
  adapter: SyntheticBookingAdapter,
  input: BookingCreateInput
): Promise<BookingCreateInput> {
  const first = await adapter.createBooking(input);
  assert.equal(first.ok ? undefined : first.problem.code, "requires_user_confirmation");
  const token = first.ok ? undefined : first.problem.message.match(/approval\.token="([^"]+)"/)?.[1];
  assert.ok(token, "expected an adapter-issued approval token");
  return { ...input, approval: { confirmed: true, token } };
}

function adapterFor(server: SyntheticBookingServer, organizationId: string): SyntheticBookingAdapter {
  return new SyntheticBookingAdapter({
    apiBaseUrl: server.url,
    organizationId
  });
}

async function armScenario(
  server: SyntheticBookingServer,
  organizationId: string,
  nextCreate: "requires_verification" | "slot_taken" | "rate_limited"
): Promise<void> {
  const response = await fetch(new URL("/test/scenarios", server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organization_id: organizationId, next_create: nextCreate })
  });
  assert.equal(response.status, 204);
}

async function createInputFor(
  adapter: SyntheticBookingAdapter,
  fixture: OrgFixture,
  serviceId: string,
  idempotencySuffix: string,
  scheduleId = fixture.defaultScheduleId
): Promise<BookingCreateInput> {
  const service = await adapter.describeService({ service_id: serviceId });
  assert.equal(service.ok, true, `${fixture.id}:${serviceId}:service`);
  const policy = await adapter.explainPolicy({ service_id: serviceId });
  assert.equal(policy.ok, true, `${fixture.id}:${serviceId}:policy`);
  const slots = await adapter.findAvailability({
    service_id: serviceId,
    schedule_id: scheduleId,
    date: futureDateIso(4)
  });
  assert.equal(slots.ok, true, `${fixture.id}:${serviceId}:slots`);
  assert.ok(slots.ok && slots.value[0], `${fixture.id}:${serviceId}:first slot`);
  if (!service.ok || !policy.ok || !slots.ok || !slots.value[0]) {
    throw new Error("unreachable test fixture failure");
  }

  return buildCreateInput({
    fixture,
    service: service.value,
    slot: slots.value[0],
    idempotencySuffix,
    currency: policy.value.organization?.currency ?? "USD"
  });
}

function buildCreateInput(input: {
  fixture: OrgFixture;
  service: Service;
  slot: Slot;
  idempotencySuffix: string;
  currency: string;
}): BookingCreateInput {
  const price = input.service.price ?? input.slot.price;
  const cap = mandateCap(price, input.currency);
  const mandate: BookingMandate = {
    id: `mandate_${input.idempotencySuffix}`,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    allowed_actions: ["booking.create"],
    organization_id: input.fixture.id,
    service_ids: [input.service.id],
    provider_ids: input.slot.provider_id ? [input.slot.provider_id] : undefined,
    schedule_ids: [input.slot.schedule_id],
    earliest_start: input.slot.starts_at_local,
    latest_end: input.slot.ends_at_local ?? input.slot.starts_at_local,
    max_price: cap,
    allow_policy_fee: false,
    max_extra_fee: { amount_minor: 0, currency: cap.currency }
  };
  const time = input.slot.starts_at_local.slice(11, 16);
  return {
    mandate,
    idempotency_key: deterministicUuid(`reference-backend:${input.idempotencySuffix}`),
    service_id: input.service.id,
    schedule_id: input.slot.schedule_id,
    provider_id: input.slot.provider_id ?? `${input.fixture.id}_provider`,
    date: input.slot.starts_at_local.slice(0, 10),
    time,
    customer: {
      id: `customer_${input.fixture.id}`,
      phone: "+15555550100",
      display_name: "Jordan Rivera"
    }
  };
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function mandateCap(price: Money | undefined, fallbackCurrency: string): Money {
  if (price?.amount_minor !== undefined) {
    return {
      amount_minor: price.amount_minor,
      currency: price.currency
    };
  }

  return {
    amount_minor: 1_000_000,
    currency: price?.currency ?? fallbackCurrency
  };
}

function withMandate(
  input: BookingCreateInput,
  mandatePatch: Partial<BookingMandate>
): BookingCreateInput {
  return {
    ...input,
    mandate: {
      ...input.mandate,
      ...mandatePatch
    }
  };
}

function futureDateIso(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function assertSeedLooksLikeVertical(
  seed: ReferenceOrganizationSeed | undefined,
  name: string,
  currency: string,
  timezone: string
): void {
  assert.ok(seed);
  assert.equal(seed.name, name);
  assert.equal(seed.currency, currency);
  assert.equal(seed.timezone, timezone);
  assert.ok(seed.locations.length >= 1);
  assert.equal(seed.providers.length, 2);
  assert.ok(seed.services.length >= 6);
}
