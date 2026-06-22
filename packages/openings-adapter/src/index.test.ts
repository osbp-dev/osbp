import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { OSBP_VERSION, type BookingCreateInput, type BookingMandate } from "@osbp/core";
import {
  captureUpstreamMeta,
  loadOpeningsConfigFromEnv,
  loadOsbpEnv,
  mapOperatingHours,
  OpeningsAdapter,
  runReadOnlySmoke,
  wallClockToInstant,
  type OpeningsAdapterConfig
} from "./index.js";

const config: OpeningsAdapterConfig = {
  apiBaseUrl: "https://api.openings.test",
  salonSlug: "demo",
  salonId: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
  scheduleIds: ["schedule_1"],
  providerUserIds: ["provider_1"],
  serviceIds: ["service_1"],
  testCustomerId: "customer_1",
  testCustomerPhone: "+15555550100"
};

const mandate: BookingMandate = {
  id: "mandate_1",
  expires_at: "2030-05-01T13:00:00Z",
  allowed_actions: ["booking.create"],
  organization_id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
  service_ids: ["service_1"],
  provider_ids: ["provider_1"],
  schedule_ids: ["schedule_1"],
  earliest_start: "2030-05-02T09:00:00",
  latest_end: "2030-05-02T18:00:00",
  max_price: { amount_minor: 10000, currency: "USD" },
  allow_policy_fee: false,
  max_extra_fee: { amount_minor: 0, currency: "USD" }
};

const bookingInput: BookingCreateInput = {
  mandate,
  idempotency_key: "idem_1",
  service_id: "service_1",
  schedule_id: "schedule_1",
  provider_id: "provider_1",
  date: "2030-05-02",
  time: "10:00",
  customer: {
    id: "customer_1",
    phone: "+15555550100"
  }
};

afterEach(() => {
  delete (globalThis as { fetch?: typeof fetch }).fetch;
});

describe("OpeningsAdapter booking create", { concurrency: false }, () => {
  it("read-only smoke checks mandate reachability separately from happy-path bookability", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse({ timezone: "America/Los_Angeles", currency: "USD", country: "US" }) }),
      jsonResponse({ data: [locationResponse()] }),
      jsonResponse({ data: [serviceResponse()] }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: [locationResponse()] }),
      jsonResponse({
        data: [
          {
            teamMemberId: "provider_1",
            schedule: { id: "schedule_1" },
            services: [{ id: "service_1", price: 80 }],
            openings: ["10:00"]
          }
        ]
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await runReadOnlySmoke(adapter);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.service.id, "service_1");
    assert.equal(result.value.slots.length, 1);
    assert.deepEqual(result.value.checks, {
      mandate_reachability: {
        ok: true,
        message: "service.describe + policy.explain expose the read-tool fields needed to construct BookingMandate scope"
      },
      happy_path_bookability: {
        ok: true,
        message: "validated 1 slot(s) against a constructed v0.1.0 BookingMandate"
      }
    });
  });

  it("read-only smoke reports missing mandate reachability without calling it unsupported bookability", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: { name: "Harbor Light Salon" } }),
      jsonResponse({ data: [locationResponse()] }),
      jsonResponse({ data: [serviceResponse()] }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() })
    ]);

    const adapter = new OpeningsAdapter({
      ...config,
      salonId: undefined
    });
    const result = await runReadOnlySmoke(adapter);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "missing_mandate_reachability");
    assert.match(
      result.ok ? "" : result.problem.message,
      /policy\.explain\.organization\.id -> BookingMandate\.organization_id/
    );
  });

  it("read-only smoke reports policy organization canary shape drift", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      // Currency is present (so Service.price populates and mandate reachability
      // passes) but country is omitted, which the organization canary requires.
      // This isolates the canary's organization-shape check, which runs after
      // reachability, rather than tripping reachability first.
      jsonResponse({
        data: salonResponse({ timezone: "America/Los_Angeles", currency: "USD" })
      }),
      jsonResponse({ data: [locationResponse()] }),
      jsonResponse({ data: [serviceResponse()] }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: [locationResponse()] }),
      jsonResponse({
        data: [
          {
            teamMemberId: "provider_1",
            schedule: { id: "schedule_1" },
            services: [{ id: "service_1", price: 80 }],
            openings: ["10:00"]
          }
        ]
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await runReadOnlySmoke(adapter);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "smoke_shape_drift");
    assert.match(result.ok ? "" : result.problem.message, /policy\.explain organization canary/);
    assert.match(result.ok ? "" : result.problem.message, /Policy\.organization\.country expected non-empty string, got missing/);
    assert.equal(calls.some((call) => call.url.pathname === "/v1/openings/members"), false);
  });

  it("read-only smoke reports slot canary shape drift", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse({ timezone: "America/Los_Angeles", currency: "USD", country: "US" }) }),
      jsonResponse({ data: [locationResponse()] }),
      jsonResponse({ data: [serviceResponse()] }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: [locationResponse()] }),
      jsonResponse({
        data: [
          {
            teamMemberId: "provider_1",
            schedule: { id: "schedule_1" },
            services: [{ id: "service_1" }],
            openings: ["10:00"]
          }
        ]
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await runReadOnlySmoke(adapter);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "smoke_shape_drift");
    assert.match(result.ok ? "" : result.problem.message, /availability\.find Slot canary/);
    assert.match(result.ok ? "" : result.problem.message, /Slot\.price\.amount_minor expected finite number, got missing/);
  });

  it("read-only smoke reports unsupported happy-path fixtures separately from mandate reachability", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      // Currency is required for Service.price (a Money) to populate, which
      // mandate reachability checks before the consultation gate this test
      // exercises. Without it the smoke would stop at missing_mandate_reachability.
      jsonResponse({ data: salonResponse({ currency: "USD" }) }),
      jsonResponse({ data: [locationResponse()] }),
      jsonResponse({ data: [serviceResponse()] }),
      jsonResponse({ data: serviceResponse({ hasConsultation: true }) }),
      jsonResponse({ data: serviceResponse({ hasConsultation: true }) })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await runReadOnlySmoke(adapter);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "unsupported_smoke_bookability_fixture");
    assert.match(result.ok ? "" : result.problem.message, /requires_consultation=true/);
  });

  it("collapses per-provider service copies onto the salon-level referenceId", async () => {
    // Two providers each carry their own per-provider "service copy" with a
    // distinct `id`, both pointing at the salon-level `service_1` via
    // `referenceId`. Slot.service_id should be `service_1` for both, so a
    // mandate built from `service.describe` round-trips into availability and
    // so the agent doesn't see three different ids for one logical service.
    // Regression coverage for the per-provider service-copy id collapse.
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: [] }),
      jsonResponse({
        data: [
          {
            teamMemberId: "provider_1",
            schedule: { id: "member_schedule_1" },
            services: [
              { id: "rose_color_copy", referenceId: "service_1", price: 80 }
            ],
            openings: ["10:00"]
          },
          {
            teamMemberId: "provider_2",
            schedule: { id: "member_schedule_2" },
            services: [
              { id: "natalie_color_copy", referenceId: "service_1", price: 80 }
            ],
            openings: ["11:00"]
          }
        ]
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.findAvailability({
      service_id: "service_1",
      schedule_id: "host_schedule_1",
      date: "2030-05-02"
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 2);
    assert.equal(result.value[0]?.service_id, "service_1");
    assert.equal(result.value[1]?.service_id, "service_1");
    // Per-provider schedule ids still flow through as the leaf: Openings
    // accepts the per-provider sub-schedule.id at create time. Only the service
    // case is anchored to the parent.
    assert.equal(result.value[0]?.schedule_id, "member_schedule_1");
    assert.equal(result.value[1]?.schedule_id, "member_schedule_2");
  });

  it("falls back to the per-provider service id when referenceId is absent", async () => {
    // Defensive case: if a member record omits referenceId (older shape, or a
    // service that isn't a "copy"), keep emitting the record's own id rather
    // than an undefined service_id. The salon-level/per-provider distinction only
    // exists when referenceId is populated.
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: [] }),
      jsonResponse({
        data: [
          {
            teamMemberId: "provider_1",
            schedule: { id: "member_schedule_1" },
            services: [{ id: "service_1", price: 80 }],
            openings: ["10:00"]
          }
        ]
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.findAvailability({
      service_id: "service_1",
      schedule_id: "host_schedule_1",
      date: "2030-05-02"
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value[0]?.service_id : undefined, "service_1");
  });

  it("propagates schedule_timezone with location-then-salon fallback", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      // Salon carries a tz; one location carries its own tz, another omits it.
      jsonResponse({ data: { id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w", name: "Harbor Light Salon", timezone: "America/Los_Angeles" } }),
      jsonResponse({
        data: [
          { id: "loc_with_tz", name: "NYC", timezone: "America/New_York" },
          { id: "loc_without_tz", name: "Hub" }
        ]
      }),
      jsonResponse({
        data: [
          {
            teamMemberId: "provider_1",
            schedule: { id: "loc_with_tz" },
            services: [{ id: "service_1", price: 80 }],
            openings: ["10:00"]
          },
          {
            teamMemberId: "provider_2",
            schedule: { id: "loc_without_tz" },
            services: [{ id: "service_1", price: 80 }],
            openings: ["11:00"]
          }
        ]
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.findAvailability({
      service_id: "service_1",
      schedule_id: "loc_with_tz",
      date: "2030-05-02"
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Both slots resolve against input.schedule_id ("loc_with_tz") because
    // /v1/locations is keyed by the requested location, not by the per-provider
    // sub-schedule id. So both pick up the location-level tz, not the salon
    // fallback. The salon fallback is exercised when /v1/locations is empty
    // or the requested location omits timezone — see "...without_tz" below.
    assert.equal(result.value[0]?.schedule_timezone, "America/New_York");
    assert.equal(result.value[1]?.schedule_timezone, "America/New_York");
    // Wall-clock value lives in starts_at_local; starts_at is the canonical
    // absolute instant computed from it via the location tz. 10:00 / 11:00
    // America/New_York on 2030-05-02 (EDT, -4) are 14:00 / 15:00 UTC.
    assert.equal(result.value[0]?.starts_at_local, "2030-05-02T10:00:00");
    assert.equal(result.value[0]?.starts_at, "2030-05-02T14:00:00.000Z");
    assert.equal(result.value[1]?.starts_at_local, "2030-05-02T11:00:00");
    assert.equal(result.value[1]?.starts_at, "2030-05-02T15:00:00.000Z");
  });

  it("falls back to salon timezone when location timezone is missing", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: { id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w", name: "Harbor Light Salon", timezone: "America/Los_Angeles" } }),
      jsonResponse({ data: [{ id: "schedule_1", name: "Hub" }] }),
      jsonResponse({
        data: [
          {
            teamMemberId: "provider_1",
            schedule: { id: "schedule_1" },
            services: [{ id: "service_1", price: 80 }],
            openings: ["10:00"]
          }
        ]
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.findAvailability({
      service_id: "service_1",
      schedule_id: "schedule_1",
      date: "2030-05-02"
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value[0]?.schedule_timezone : undefined, "America/Los_Angeles");
    // The absolute instant is computed against the salon-fallback tz: 10:00
    // America/Los_Angeles on 2030-05-02 (PDT, -7) is 17:00 UTC.
    assert.equal(result.ok ? result.value[0]?.starts_at_local : undefined, "2030-05-02T10:00:00");
    assert.equal(result.ok ? result.value[0]?.starts_at : undefined, "2030-05-02T17:00:00.000Z");
  });

  it("leaves Slot.starts_at undefined when no schedule timezone is resolvable", async () => {
    // When neither the location nor the salon carries a tz, the adapter must
    // NOT guess an instant. starts_at_local still carries the wall-clock value;
    // starts_at is absent (dropUndefined strips it).
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: { id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w", name: "Harbor Light Salon" } }),
      jsonResponse({ data: [{ id: "schedule_1", name: "Hub" }] }),
      jsonResponse({
        data: [
          {
            teamMemberId: "provider_1",
            schedule: { id: "schedule_1" },
            services: [{ id: "service_1", price: 80 }],
            openings: ["10:00"]
          }
        ]
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.findAvailability({
      service_id: "service_1",
      schedule_id: "schedule_1",
      date: "2030-05-02"
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value[0]?.starts_at_local, "2030-05-02T10:00:00");
    assert.equal(result.value[0]?.schedule_timezone, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(result.value[0] ?? {}, "starts_at"), false);
  });

  it("posts a mandate-validated booking without piping idempotency_key into requestId", async () => {
    // The wire payload omits requestId for normal bookings; OSBP's local
    // idempotency cache handles dedupe.
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: { id: "appt_1", status: "CONFIRMED" } })
    ]);

    const adapter = new OpeningsAdapter(config);
    const approvedInput = await approveBooking(adapter, bookingInput);
    const result = await adapter.createBooking(approvedInput);

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.value.booking_id : undefined, "appt_1");

    const createCall = calls.find((call) => call.url.pathname === "/v1/appointments/create");
    assert.ok(createCall);
    assert.equal(createCall.init.headers?.["x-osbp-source"], `openings-adapter/${OSBP_VERSION}`);
    assert.match(
      createCall.init.headers?.["user-agent"] ?? "",
      new RegExp(`^OSBP/${OSBP_VERSION} openings-adapter/${OSBP_VERSION} node/\\d+$`),
      "User-Agent must be OSBP/{ver} openings-adapter/{ver} node/{major}"
    );
    const body = JSON.parse(String(createCall.init.body));
    assert.deepEqual(body, {
      salonId: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      userId: "provider_1",
      scheduleId: "schedule_1",
      customerId: "customer_1",
      date: "2030-05-02",
      time: "10:00",
      services: [{ id: "service_1" }],
      sendNotifications: true,
      metadata: {
        osbp_idempotency_key: "idem_1",
        osbp_mandate_id: "mandate_1",
        osbp_source: `openings-adapter/${OSBP_VERSION}`
      }
    });
    assert.equal(Object.prototype.hasOwnProperty.call(body, "requestId"), false, "wire payload must not include requestId");
    // metadata is an allowlisted, PII-free identity map: no customer contact fields.
    const metadataKeys = Object.keys(body.metadata);
    assert.deepEqual(metadataKeys, ["osbp_idempotency_key", "osbp_mandate_id", "osbp_source"]);
    assert.equal(metadataKeys.some((k) => /phone|email|customer|verification|code|name/i.test(k)), false);
  });

  it("normalizes whole-second booking times before posting to Openings", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: { id: "appt_1", status: "CONFIRMED" } })
    ]);

    const adapter = new OpeningsAdapter(config);
    const approvedInput = await approveBooking(adapter, {
      ...bookingInput,
      time: "10:00:00"
    });
    const result = await adapter.createBooking(approvedInput);

    assert.equal(result.ok, true);
    const createCall = calls.find((call) => call.url.pathname === "/v1/appointments/create");
    assert.ok(createCall);
    const body = JSON.parse(String(createCall.init.body));
    assert.equal(body.time, "10:00");
    assert.equal(result.ok ? result.value.text : undefined, "Booked Haircut on 2030-05-02 at 10:00. Openings appointment id: appt_1.");
  });

  it("requires adapter-issued final approval before any Openings create", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() })
    ]);

    const adapter = new OpeningsAdapter({ ...config, testCustomerId: undefined });
    const result = await adapter.createBooking({
      ...bookingInput,
      customer: { phone: "+15555550100" }
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "requires_user_confirmation");
    assert.match(result.ok ? "" : result.problem.message, /Book Haircut/);
    assert.match(result.ok ? "" : result.problem.message, /No upfront payment or deposit is required to book/);
    assert.doesNotMatch(result.ok ? "" : result.problem.message, /payment requirement: none/);
    assert.match(result.ok ? "" : result.problem.message, /approval\.token="/);
    assert.equal(
      calls.some((call) => call.url.pathname === "/v1/appointments/create"),
      false,
      "must not create upstream before final approval"
    );
    assert.equal(
      calls.some((call) => call.url.pathname === "/v1/customers/booking"),
      false,
      "must not resolve customer upstream before final approval"
    );
  });

  it("rejects booking times with non-zero seconds before any upstream call", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, []);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.createBooking({
      ...bookingInput,
      time: "10:00:30"
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "invalid_booking_time");
    assert.equal(calls.length, 0);
  });

  it("rejects a booking whose service duration runs past latest_end as slot_too_late", async () => {
    // The synthesized validation slot must carry ends_at_local derived from the
    // service duration. A 60-minute service booked at 10:00 ends at 11:00; a
    // mandate with latest_end 10:30 must reject it even though the start (10:00)
    // is inside the window. Without ends_at_local the validator would compare
    // latest_end against the start time and let it through.
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.createBooking({
      ...bookingInput,
      mandate: { ...mandate, latest_end: "2030-05-02T10:30:00" }
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "slot_too_late");
    assert.equal(
      calls.some((call) => call.url.pathname === "/v1/appointments/create"),
      false,
      "must reject before any create POST"
    );
  });

  it("stamps the created Booking with starts_at_local, the absolute instant, and the tz", async () => {
    // booking.create caches a rich Booking locally. It must carry the
    // wall-clock starts_at_local plus the canonical absolute instant computed
    // from the salon tz, and the tz itself. 10:00 America/Los_Angeles on
    // 2030-05-02 (PDT, -7) is 17:00 UTC.
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse({ timezone: "America/Los_Angeles" }) }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: { id: "appt_tz", status: "CONFIRMED" } })
    ]);

    const adapter = new OpeningsAdapter(config);
    const approvedInput = await approveBooking(adapter, bookingInput);
    const create = await adapter.createBooking(approvedInput);
    assert.equal(create.ok, true);

    const status = await adapter.getBooking({ booking_id: "appt_tz", customer: bookingInput.customer });
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.value.starts_at_local, "2030-05-02T10:00:00");
    assert.equal(status.value.starts_at, "2030-05-02T17:00:00.000Z");
    assert.equal(status.value.schedule_timezone, "America/Los_Angeles");
  });

  it("returns the cached receipt for duplicate idempotency keys", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: { id: "appt_1", status: "CONFIRMED" } })
    ]);

    const adapter = new OpeningsAdapter(config);
    const approvedInput = await approveBooking(adapter, bookingInput);
    const first = await adapter.createBooking(approvedInput);
    const second = await adapter.createBooking({ ...bookingInput, verification_code: "123456" });

    assert.deepEqual(second, first);
    assert.equal(calls.filter((call) => call.url.pathname === "/v1/appointments/create").length, 1);
  });

  it("dedupes genuinely concurrent same-key bookings to a single create POST", async () => {
    // The completed-result cache is only written after /v1/appointments/create
    // returns, so two genuinely concurrent createBooking calls that present the
    // same idempotency_key both observe the cache miss and would both book —
    // duplicate Openings appointments for one key. Sequential retries are
    // already deduped (see the test above); concurrent ones were not until the
    // key was reserved before the network call. The local stdio server only
    // issued sequential calls, but the Vercel serverless deployment exposes the
    // shared module-level adapter to genuine concurrency on a warm instance,
    // which makes this race reachable. Routed (not order-based) fetch mock
    // because the two flows interleave and an order-based queue would deliver
    // responses to the wrong flow. verification_code differs between the two
    // callers to prove the payload-hash match (which excludes verification_code)
    // collapses a verification retry onto the same in-flight attempt.
    const calls: FetchCall[] = [];
    mockRoutedFetch(calls);

    const adapter = new OpeningsAdapter(config);
    const approvedInput = await approveBooking(adapter, bookingInput);
    const [first, second] = await Promise.all([
      adapter.createBooking(approvedInput),
      adapter.createBooking({ ...approvedInput, verification_code: "123456" })
    ]);

    assert.equal(
      calls.filter((call) => call.url.pathname === "/v1/appointments/create").length,
      1,
      "concurrent same-key bookings must hit the create endpoint exactly once"
    );
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.value.booking_id : undefined, "appt_1");
    assert.deepEqual(second, first);
  });

  it("surfaces HTTP 428 as requires_verification", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      textResponse(428, "Precondition Required", "code 123456 sent to +15555550100")
    ]);

    const adapter = new OpeningsAdapter(config);
    const approvedInput = await approveBooking(adapter, bookingInput);
    const result = await adapter.createBooking(approvedInput);

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "requires_verification");
    // The 428 body can echo the customer contact or a verification code; it must
    // not reach Problem.message, which flows to the agent context and the audit log.
    assert.doesNotMatch(result.ok ? "" : result.problem.message, /123456/);
    assert.doesNotMatch(result.ok ? "" : result.problem.message, /\+15555550100/);
  });
});

describe("OpeningsAdapter booking status", { concurrency: false }, () => {
  it("returns the cached booking when getBooking matches a local idempotency entry", async () => {
    // booking.create caches the rich Booking locally (mandate + receipt
    // + Booking) so booking.status can answer for OSBP-created appointments
    // without calling the history endpoint.
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: { id: "appt_1", status: "CONFIRMED" } })
    ]);

    const adapter = new OpeningsAdapter(config);
    const approvedInput = await approveBooking(adapter, bookingInput);
    const create = await adapter.createBooking(approvedInput);
    assert.equal(create.ok, true);

    const status = await adapter.getBooking({
      booking_id: "appt_1",
      customer: bookingInput.customer
    });

    assert.equal(status.ok, true);
    assert.equal(status.ok ? status.value.id : undefined, "appt_1");
    // Cache hit short-circuits: neither the review endpoint nor history is hit.
    assert.equal(
      calls.filter(
        (c) => c.url.pathname.endsWith("/review") || c.url.pathname.startsWith("/v1/appointments/history")
      ).length,
      0
    );
  });

  it("reads the public appointment review endpoint when a booking id is supplied and uncached", async () => {
    // Openings' public GET /v1/appointments/{id}/review is an id-as-capability
    // confirmation read with no auth and no verification step. With a booking id
    // but no cache hit, getBooking reads it directly and does not call the
    // history endpoint.
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({
        data: {
          id: "appt_42",
          status: "CONFIRMED",
          services: [{ id: "service_1" }],
          schedule: { id: "schedule_1" },
          user: { id: "provider_1" },
          customer: { id: "customer_1" },
          date: "2030-05-02",
          time: "10:00"
        }
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.getBooking({ booking_id: "appt_42" });

    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.value : undefined, {
      id: "appt_42",
      status: "booked",
      service_id: "service_1",
      schedule_id: "schedule_1",
      provider_id: "provider_1",
      starts_at_local: "2030-05-02T10:00:00",
      customer_id: "customer_1"
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.pathname, "/v1/appointments/appt_42/review");
    assert.equal(calls.filter((c) => c.url.pathname.startsWith("/v1/appointments/history")).length, 0);
  });

  it("returns booking_not_found when the review lookup 404s", async () => {
    mockFetch([], [
      textResponse(404, "Not Found", "NOT_FOUND")
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.getBooking({ booking_id: "appt_missing" });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "booking_not_found");
  });

  it("returns booking_not_found when the no-id history probe reports no upcoming appointments", async () => {
    // With no booking id, getBooking falls back to the history probe. That
    // endpoint requires an interactive verification step the adapter cannot
    // complete, so it returns only `{ hasUpcomingAppointments }`.
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ hasUpcomingAppointments: false })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.getBooking({
      customer: { id: "customer_1", phone: "+15555550100" }
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? undefined : result.problem.code, "booking_not_found");
    const historyCall = calls.find((c) => c.url.pathname.startsWith("/v1/appointments/history"));
    assert.ok(historyCall);
    // The adapter cannot supply a verificationCode from a read tool, so the
    // probe URL must not include one.
    assert.equal(historyCall.url.searchParams.has("verificationCode"), false);
  });

  it("fails closed with booking_status_requires_verification when the no-id probe reports upcoming appointments", async () => {
    // Probe reports that upcoming appointments exist, without ids, times, or
    // customerId. OSBP treats the platform as the system of record (see the
    // spec Security and Privacy Considerations) rather than constructing
    // booking truth locally, so it returns a problem.
    mockFetch([], [
      jsonResponse({ hasUpcomingAppointments: true })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.getBooking({
      customer: { id: "customer_1", phone: "+15555550100" }
    });

    assert.equal(result.ok, false);
    assert.equal(
      result.ok ? undefined : result.problem.code,
      "booking_status_requires_verification"
    );
  });

  it("uses the by-email probe when only an email is provided and no booking id", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ hasUpcomingAppointments: false })
    ]);

    // Drop the test phone fallback so the adapter routes to /by-email.
    const adapter = new OpeningsAdapter({ ...config, testCustomerPhone: undefined });
    const result = await adapter.getBooking({
      customer: { id: "customer_1", email: "alice@example.test" }
    });

    assert.equal(result.ok, false);
    const historyCall = calls.find((c) => c.url.pathname === "/v1/appointments/history/by-email");
    assert.ok(historyCall, "expected by-email probe to be hit");
    assert.equal(historyCall.url.searchParams.get("email"), "alice@example.test");
    assert.equal(historyCall.url.searchParams.has("verificationCode"), false);
  });
});

describe("OpeningsAdapter upstream metadata", { concurrency: false }, () => {
  it("captures the recipe header set from a response", () => {
    const response = new Response("{}", {
      status: 200,
      headers: {
        server: "Fly/02244e829 (2026-06-11)",
        "fly-request-id": "req_abc-lax",
        "x-api-version": "2026-06-01",
        deprecation: "@1767139200",
        sunset: "Sat, 01 Aug 2026 00:00:00 GMT",
        "x-ratelimit-limit": "200",
        "x-ratelimit-remaining": "192",
        "ratelimit-policy": "200;w=60"
      }
    });

    assert.deepEqual(captureUpstreamMeta("GET /v1/openings", response), {
      call: "GET /v1/openings",
      status: 200,
      server: "Fly/02244e829 (2026-06-11)",
      request_id: "req_abc-lax",
      api_version: "2026-06-01",
      deprecation: "@1767139200",
      sunset: "Sat, 01 Aug 2026 00:00:00 GMT",
      ratelimit: {
        "x-ratelimit-limit": "200",
        "x-ratelimit-remaining": "192",
        "ratelimit-policy": "200;w=60"
      }
    });
  });

  it("leaves optional fields absent on a bare response", () => {
    const meta = captureUpstreamMeta("POST /v1/appointments/create", new Response("{}", { status: 201 }));
    assert.deepEqual(meta, { call: "POST /v1/appointments/create", status: 201 });
  });

  it("captures the Openings-Version header into api_version", () => {
    const response = new Response("{}", { status: 200, headers: { "openings-version": "2026-06-18" } });
    assert.equal(captureUpstreamMeta("GET /v1/openings", response).api_version, "2026-06-18");
  });

  it("prefers Openings-Version over api-version / x-api-version", () => {
    const response = new Response("{}", {
      status: 200,
      headers: { "openings-version": "2026-06-18", "x-api-version": "2026-06-01" }
    });
    assert.equal(captureUpstreamMeta("GET /v1/openings", response).api_version, "2026-06-18");
  });

  it("records upstream metadata on adapter calls and redacts contact-bearing path segments", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: { hasUpcomingAppointments: false } }, { server: "Fly/test", "fly-request-id": "req_1" })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.getBooking({ customer: { phone: "+15555550100" } });

    assert.equal(result.ok, false);
    // The history path embeds the customer phone; the recorded call must not.
    assert.deepEqual(adapter.upstreamMeta, {
      call: "GET /v1/appointments/history/:redacted",
      status: 200,
      server: "Fly/test",
      request_id: "req_1"
    });
  });

  it("warns once per endpoint per process when lifecycle headers appear", async () => {
    const calls: FetchCall[] = [];
    const warnings: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      warnings.push(String(message));
    };
    try {
      mockFetch(calls, [
        jsonResponse({ data: { hasUpcomingAppointments: false } }, { sunset: "Sat, 01 Aug 2026 00:00:00 GMT" }),
        jsonResponse({ data: { hasUpcomingAppointments: false } }, { sunset: "Sat, 01 Aug 2026 00:00:00 GMT" })
      ]);

      const adapter = new OpeningsAdapter(config);
      await adapter.getBooking({ customer: { phone: "+15555550100" } });
      await adapter.getBooking({ customer: { phone: "+15555550100" } });

      const lifecycleWarnings = warnings.filter((line) => line.includes("upstream_lifecycle_warning"));
      assert.equal(lifecycleWarnings.length, 1);
      assert.match(lifecycleWarnings[0] ?? "", /sunset/);
      assert.match(lifecycleWarnings[0] ?? "", /:redacted/);
    } finally {
      console.error = originalError;
    }
  });
});

describe("OpeningsAdapter error mapping", { concurrency: false }, () => {
  it("maps HTTP 429 to a retryable rate_limited problem", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      textResponse(429, "Too Many Requests", "RATE_LIMITED")
    ]);

    const adapter = new OpeningsAdapter(config);
    const approvedInput = await approveBooking(adapter, bookingInput);
    const result = await adapter.createBooking(approvedInput);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.problem.code, "rate_limited");
    assert.equal(result.problem.retryable, true);
  });

  it("keeps the upstream body and customer contact out of the problem message", async () => {
    // The history path embeds the customer phone, and this upstream body echoes
    // it back. Neither may reach Problem.message, which flows to the agent and
    // the audit log. The redacted path survives for diagnosis; 5xx is retryable.
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      textResponse(500, "Internal Server Error", "lookup failed for +15555550100")
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.getBooking({ customer: { phone: "+15555550100" } });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.problem.message.includes("+15555550100"), false);
    assert.equal(result.problem.message.includes("lookup failed"), false);
    assert.match(result.problem.message, /:redacted/);
    assert.equal(result.problem.retryable, true);
  });

  it("keeps the upstream body out of the problem message for 4xx, logging it to stderr instead", async () => {
    // 4xx bodies can echo customer contact and must not reach Problem.message
    // (which flows to the agent and the key-based audit redactor, which would not
    // scrub a body concatenated into `message`). Operator debuggability is
    // preserved on stderr only.
    const calls: FetchCall[] = [];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (message?: unknown) => {
      errors.push(String(message));
    };
    try {
      mockFetch(calls, [
        jsonResponse({ data: salonResponse() }),
        jsonResponse({ data: serviceResponse() }),
        jsonResponse({ data: serviceResponse() }),
        jsonResponse({ data: serviceResponse() }),
        jsonResponse({ data: serviceResponse() }),
        textResponse(422, "Unprocessable Entity", JSON.stringify({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid input" } }))
      ]);

      const adapter = new OpeningsAdapter(config);
      const approvedInput = await approveBooking(adapter, bookingInput);
      const result = await adapter.createBooking(approvedInput);

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.problem.message.includes("VALIDATION_ERROR"), false, "4xx body must not appear in problem message");
      assert.ok(
        errors.some((line) => line.includes("upstream_error") && line.includes("VALIDATION_ERROR")),
        "4xx body should be logged to stderr for operators"
      );
    } finally {
      console.error = originalError;
    }
  });

  it("does not treat a non-conflict status as slot_taken even when the body mentions a slot", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() }),
      textResponse(500, "Internal Server Error", "slot cache temporarily unavailable")
    ]);

    const adapter = new OpeningsAdapter(config);
    const approvedInput = await approveBooking(adapter, bookingInput);
    const result = await adapter.createBooking(approvedInput);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.notEqual(result.problem.code, "slot_taken");
    assert.equal(result.problem.retryable, true);
  });

  it("returns a Problem instead of throwing when required config is missing mid-flow", async () => {
    // requireSalonId throws inside performBooking's prelude when OPENINGS_SALON_ID
    // is unset. The adapter contract requires that to surface as an
    // AdapterResult, never a rejected promise (the outer catch in performBooking).
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: serviceResponse() }),
      jsonResponse({ data: serviceResponse() })
    ]);

    const adapter = new OpeningsAdapter({ ...config, salonId: undefined });
    const result = await adapter.createBooking(bookingInput);

    assert.equal(result.ok, false);
  });
});

describe("wallClockToInstant", () => {
  it("converts a PDT wall-clock to the correct summer (-7) UTC instant", () => {
    // America/Los_Angeles is on Pacific Daylight Time (UTC-7) on 2026-07-01,
    // so 09:00 local is 16:00 UTC. toISOString emits millisecond precision.
    assert.equal(
      wallClockToInstant("2026-07-01T09:00:00", "America/Los_Angeles"),
      "2026-07-01T16:00:00.000Z"
    );
  });

  it("converts a PST wall-clock to the correct winter (-8) UTC instant", () => {
    // On 2026-12-01 the same zone is on Pacific Standard Time (UTC-8), so
    // 09:00 local is 17:00 UTC. The one-hour DST difference from the summer
    // case above is the whole point of resolving the wall-clock in-zone.
    assert.equal(
      wallClockToInstant("2026-12-01T09:00:00", "America/Los_Angeles"),
      "2026-12-01T17:00:00.000Z"
    );
  });

  it("returns undefined when the timezone is missing", () => {
    assert.equal(wallClockToInstant("2026-07-01T09:00:00", undefined), undefined);
  });
});

describe("mapOperatingHours", () => {
  it("omits days the platform marks closed and emits no is_open flag", () => {
    const hours = mapOperatingHours([
      { day: 1, open: "09:00", close: "17:00", isOpen: true },
      { day: 6, open: "10:00", close: "14:00", isOpen: false },
      { day: 3, open: "09:00", close: "17:00" }
    ]);
    assert.deepEqual(hours, [
      { day: 1, open: "09:00", close: "17:00" },
      { day: 3, open: "09:00", close: "17:00" }
    ]);
  });

  it("converts Openings JS weekday numbering (0 = Sunday) to ISO 8601 (7 = Sunday)", () => {
    assert.deepEqual(
      mapOperatingHours([{ day: 0, open: "11:00", close: "15:00" }]),
      [{ day: 7, open: "11:00", close: "15:00" }]
    );
  });

  it("drops rows missing open/close and returns undefined when nothing remains", () => {
    assert.equal(mapOperatingHours([{ day: 2, open: "09:00" }]), undefined);
    assert.equal(
      mapOperatingHours([{ day: 2, open: "09:00", close: "17:00", isOpen: false }]),
      undefined
    );
    assert.equal(mapOperatingHours([]), undefined);
    assert.equal(mapOperatingHours("nope"), undefined);
  });
});

describe("OpeningsAdapter env loading", () => {
  it("layers .env.local files with the repo-root file winning over the example file", () => {
    const root = mkdtempSync(join(tmpdir(), "osbp-env-"));
    try {
      mkdirSync(join(root, "examples/v0.1.0/openings"), { recursive: true });
      writeFileSync(
        join(root, "examples/v0.1.0/openings/.env.local"),
        "# example fallback\nOPENINGS_SALON_SLUG=example-slug\nOPENINGS_SALON_ID=example-id\n"
      );
      writeFileSync(
        join(root, ".env.local"),
        "OPENINGS_SALON_ID=\"root-id\"\nOPENINGS_API_BASE_URL='https://root.example'\n\nMALFORMED_LINE\n"
      );

      const env = loadOsbpEnv(root);
      // The root .env.local wins over the example fallback for a shared key.
      assert.equal(env.OPENINGS_SALON_ID, "root-id");
      // A key only the example file sets still survives.
      assert.equal(env.OPENINGS_SALON_SLUG, "example-slug");
      // A root-only key is present with its surrounding quotes stripped.
      assert.equal(env.OPENINGS_API_BASE_URL, "https://root.example");
      // A line with no "=" is ignored rather than producing a bogus key.
      assert.equal(env.MALFORMED_LINE, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty object when no env files exist", () => {
    const root = mkdtempSync(join(tmpdir(), "osbp-env-"));
    try {
      assert.deepEqual(loadOsbpEnv(root), {});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps env values to config with defaults and comma-list splitting", () => {
    const mapped = loadOpeningsConfigFromEnv({
      OPENINGS_SCHEDULE_IDS: "s1, s2 ,s3",
      OPENINGS_SERVICE_IDS: "svc1",
      OPENINGS_STAFF_USER_IDS: ""
    });
    assert.equal(mapped.apiBaseUrl, "https://api.openings.link");
    assert.equal(mapped.salonSlug, "demo");
    assert.deepEqual(mapped.scheduleIds, ["s1", "s2", "s3"]);
    assert.deepEqual(mapped.serviceIds, ["svc1"]);
    assert.deepEqual(mapped.providerUserIds, []);
  });

  it("lets process env override the layered files when callers spread it on top", () => {
    const root = mkdtempSync(join(tmpdir(), "osbp-env-"));
    try {
      writeFileSync(join(root, ".env.local"), "OPENINGS_SALON_ID=file-id\n");
      const merged = loadOpeningsConfigFromEnv({ ...loadOsbpEnv(root), OPENINGS_SALON_ID: "process-id" });
      assert.equal(merged.salonId, "process-id");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("OpeningsAdapter edge coverage", { concurrency: false }, () => {
  it("sends a verification body shaped for the default booking purpose", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [jsonResponse({ data: { sent: true } })]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.sendVerification({});

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.purpose, "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w");
    assert.equal(result.value.method, "sms");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url.pathname, "/v1/verifications/send");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    assert.equal(body.phoneNumber, "+15555550100");
    assert.equal(body.purpose, "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w");
    // The optional email is dropped, not sent as null.
    assert.equal("email" in body, false);
  });

  it("verifies a code with the default booking purpose and nested customer body", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [jsonResponse({ data: { verified: true } })]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.verifyCode({ code: "123456" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.verified, true);
    assert.equal(result.value.purpose, "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w");
    assert.equal(result.value.method, "sms");

    assert.equal(calls[0]?.url.pathname, "/v1/verifications/verify");
    const body = JSON.parse(String(calls[0]?.init.body)) as { code?: string; purpose?: string; customer?: { phone?: string } };
    assert.equal(body.code, "123456");
    assert.equal(body.purpose, "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w");
    assert.equal(body.customer?.phone, "+15555550100");
  });

  it("returns missing-config for verification when no phone or email is available", async () => {
    const adapter = new OpeningsAdapter({ ...config, testCustomerPhone: undefined });

    const send = await adapter.sendVerification({});
    assert.equal(send.ok, false);
    if (send.ok) return;
    assert.equal(send.problem.code, "missing_config");

    const verify = await adapter.verifyCode({ code: "1" });
    assert.equal(verify.ok, false);
    if (verify.ok) return;
    assert.equal(verify.problem.code, "missing_config");
  });

  it("creates-or-finds a customer by phone when no customer id is configured", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, init: init as FetchCall["init"] });
      const path = url.pathname;
      if (path === "/v1/customers/booking") {
        return jsonResponse({ data: { customer: { customerId: "cust_resolved" } } });
      }
      if (path === "/v1/appointments/create") {
        return jsonResponse({ data: { id: "appt_cust", status: "CONFIRMED" } });
      }
      if (path.startsWith("/v1/services/")) {
        return jsonResponse({ data: serviceResponse() });
      }
      if (path.startsWith("/v1/salons/")) {
        return jsonResponse({ data: salonResponse() });
      }
      throw new Error(`unexpected fetch path: ${path}`);
    };

    const adapter = new OpeningsAdapter({ ...config, testCustomerId: undefined });
    const phoneOnlyInput: BookingCreateInput = { ...bookingInput, customer: { phone: "+15555550100" } };
    const approvedInput = await approveBooking(adapter, phoneOnlyInput);
    const result = await adapter.createBooking(approvedInput);

    assert.equal(result.ok, true, result.ok ? "" : result.problem.message);

    const customerCall = calls.find((call) => call.url.pathname === "/v1/customers/booking");
    assert.ok(customerCall, "expected a create-or-find customer call");
    const customerBody = JSON.parse(String(customerCall?.init.body)) as Record<string, unknown>;
    assert.equal(customerBody.phoneNumber, "+15555550100");
    assert.equal(customerBody.salonId, "org_01jw3z8x9k2m4n6p8r0s1t3v5w");

    const createCall = calls.find((call) => call.url.pathname === "/v1/appointments/create");
    assert.ok(createCall, "expected an appointment create call");
    const createBody = JSON.parse(String(createCall?.init.body)) as Record<string, unknown>;
    assert.equal(createBody.customerId, "cust_resolved");
  });

  it("omits absent optional service fields instead of emitting null", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: salonResponse() }),
      jsonResponse({ data: { id: "service_1", title: "Haircut" } })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.describeService({ service_id: "service_1" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.price, undefined);
    assert.equal(result.value.duration, undefined);
    // Serializing drops the undefined keys, so the wire shape omits them rather
    // than carrying explicit nulls.
    const serialized = JSON.parse(JSON.stringify(result.value)) as Record<string, unknown>;
    assert.equal("price" in serialized, false);
    assert.equal("duration" in serialized, false);
  });
});

describe("OpeningsAdapter policy mapping", { concurrency: false }, () => {
  it("maps a rich policy with deposit payment, SMS verification, fees, and organization context", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({
        data: {
          id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
          name: "Harbor Light Salon",
          slug: "demo",
          domain: "demo.example",
          phoneNumber: "+15555550100",
          supportEmail: "help@demo.example",
          instagramHandle: "@demo",
          timezone: "America/Los_Angeles",
          currency: "USD",
          country: "US",
          totalLocations: 2,
          cancellationPolicyEnabled: true,
          cancellationPolicyHours: 24,
          cancellationPolicyNote: "24h notice",
          lateGraceMinutes: 15,
          verificationMethod: "SMS"
        }
      }),
      jsonResponse({
        data: {
          id: "service_1",
          title: "Haircut",
          paymentRequirement: "DEPOSIT",
          depositAmount: 20,
          cancellationFeeAmount: 10,
          noShowFeeAmount: 15
        }
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.explainPolicy({ service_id: "service_1" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const policy = result.value;
    assert.equal(policy.payment_requirement, "deposit");
    assert.equal(policy.verification_method, "sms");
    assert.equal(policy.cancellation_enabled, true);
    assert.equal(policy.cancellation_window, "PT24H");
    assert.equal(policy.cancellation_note, "24h notice");
    assert.equal(policy.late_grace, "PT15M");
    assert.equal(policy.deposit?.amount_minor, 2000);
    assert.equal(policy.deposit?.currency, "USD");
    assert.equal(policy.deposit?.type, "fixed");
    assert.equal(policy.cancellation_fee?.amount_minor, 1000);
    assert.equal(policy.no_show_fee?.amount_minor, 1500);
    assert.equal(policy.organization?.id, "org_01jw3z8x9k2m4n6p8r0s1t3v5w");
    assert.equal(policy.organization?.support_email, "help@demo.example");
    assert.equal(policy.organization?.total_locations, 2);
  });

  it("maps full-prepay payment and email verification", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: { id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w", name: "Harbor Light Salon", currency: "USD", verificationMethod: "EMAIL", cancellationPolicyEnabled: false } }),
      jsonResponse({ data: { id: "service_1", title: "Haircut", paymentRequirement: "FULL" } })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.explainPolicy({});

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.payment_requirement, "full_prepay");
    assert.equal(result.value.verification_method, "email");
    assert.equal(result.value.cancellation_enabled, false);
    // No deposit amount present, so the field is omitted rather than zeroed.
    assert.equal(result.value.deposit, undefined);
  });

  it("falls back to unknown payment and verification when the platform omits them", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: { id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w", name: "Harbor Light Salon", currency: "USD", verificationMethod: "phone" } }),
      jsonResponse({ data: { id: "service_1", title: "Haircut" } })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.explainPolicy({});

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.payment_requirement, "unknown");
    assert.equal(result.value.verification_method, "unknown");
  });
});

describe("OpeningsAdapter booking-status normalization", { concurrency: false }, () => {
  for (const [raw, expected] of [
    ["CONFIRMED", "booked"],
    ["COMPLETED", "completed"],
    ["CANCELLED", "cancelled"],
    ["NO_SHOW", "no_show"],
    ["PENDING", "pending"],
    ["mystery-status", "unknown"]
  ] as const) {
    it(`normalizes the upstream review status ${raw} to ${expected}`, async () => {
      mockFetch([], [
        jsonResponse({
          data: {
            id: "appt_42",
            status: raw,
            services: [{ id: "service_1" }],
            schedule: { id: "schedule_1" },
            user: { id: "provider_1" },
            customer: { id: "customer_1" },
            date: "2030-05-02",
            time: "10:00"
          }
        })
      ]);

      const adapter = new OpeningsAdapter(config);
      const result = await adapter.getBooking({ booking_id: "appt_42" });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.value.status, expected);
    });
  }

  it("resolves review booking fields from nested objects and the startsAt fallback", async () => {
    mockFetch([], [
      jsonResponse({
        data: {
          appointmentId: "appt_99",
          status: "active",
          services: [{ serviceId: "svc_nested" }],
          schedule: { scheduleId: "sched_nested" },
          teamMember: { id: "tm_nested" },
          customer: { id: "cust_nested" },
          startsAt: "2030-05-02T10:00:00Z"
        }
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.getBooking({ booking_id: "appt_99" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      id: "appt_99",
      status: "booked",
      service_id: "svc_nested",
      schedule_id: "sched_nested",
      provider_id: "tm_nested",
      starts_at_local: "2030-05-02T10:00:00Z",
      customer_id: "cust_nested"
    });
  });
});

describe("OpeningsAdapter service and availability mapping", { concurrency: false }, () => {
  it("maps service duration, price, and option upsells", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: { id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w", name: "Harbor Light Salon", currency: "USD" } }),
      jsonResponse({
        data: {
          id: "service_1",
          title: "Haircut",
          duration: 60,
          price: 80,
          hasConsultation: true,
          options: [{ id: "opt_1", title: "Add-on", price: 10, duration: 15 }]
        }
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.describeService({ service_id: "service_1" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const service = result.value;
    assert.equal(service.duration, "PT60M");
    assert.equal(service.price?.amount_minor, 8000);
    assert.equal(service.requires_consultation, true);
    assert.equal(service.options?.length, 1);
    assert.equal(service.options?.[0]?.id, "opt_1");
    assert.equal(service.options?.[0]?.name, "Add-on");
    assert.equal(service.options?.[0]?.price?.amount_minor, 1000);
    assert.equal(service.options?.[0]?.duration, "PT15M");
  });

  it("falls back to an unknown-service placeholder when the upstream record has no id", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: { id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w", currency: "USD" } }),
      jsonResponse({ data: {} })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.describeService({ service_id: "service_1" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.id, "service_1");
    assert.equal(result.value.name, "Unknown Openings service");
  });

  it("maps availability slots with provider, price, and location context", async () => {
    const calls: FetchCall[] = [];
    mockFetch(calls, [
      jsonResponse({ data: { id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w", name: "Harbor Light Salon", currency: "USD", timezone: "America/Los_Angeles" } }),
      jsonResponse({ data: [{ id: "schedule_1", name: "Studio", address: "1 Main St", timezone: "America/Los_Angeles", lat: 34.05, lng: -118.24, hours: [{ day: 1, open: "09:00", close: "17:00" }] }] }),
      jsonResponse({
        data: [
          {
            teamMemberId: "provider_1",
            name: "Amy",
            photo: "https://img.example/amy.jpg",
            hasPortfolio: true,
            schedule: { id: "schedule_1", title: "Studio" },
            services: [{ id: "service_1", price: 80 }],
            openings: ["10:00"],
            date: "2030-05-02"
          }
        ]
      })
    ]);

    const adapter = new OpeningsAdapter(config);
    const result = await adapter.findAvailability({ date: "2030-05-02" });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.length, 1);
    const slot = result.value[0];
    assert.equal(slot?.provider_name, "Amy");
    assert.equal(slot?.provider_image_url, "https://img.example/amy.jpg");
    assert.equal(slot?.provider_has_portfolio, true);
    assert.equal(slot?.price?.amount_minor, 8000);
    assert.equal(slot?.organization_name, "Harbor Light Salon");
    assert.equal(slot?.schedule_address, "1 Main St");
    assert.equal(slot?.schedule_latitude, 34.05);
    assert.equal(slot?.schedule_longitude, -118.24);
    assert.deepEqual(slot?.schedule_hours, [{ day: 1, open: "09:00", close: "17:00" }]);
    assert.equal(slot?.starts_at_local, "2030-05-02T10:00:00");
    assert.ok(slot?.starts_at, "absolute instant should be derived from the schedule timezone");
  });
});

interface FetchCall {
  url: URL;
  init: RequestInit & { headers?: Record<string, string> };
}

function mockFetch(calls: FetchCall[], responses: Response[]): void {
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      init: init as FetchCall["init"]
    });

    const response = responses.shift();
    assert.ok(response, "unexpected fetch call");
    return response;
  };
}

async function approveBooking(
  adapter: OpeningsAdapter,
  input: BookingCreateInput
): Promise<BookingCreateInput & { approval: { confirmed: true; token: string } }> {
  const approval = await adapter.createBooking(input);
  assert.equal(approval.ok, false);
  assert.equal(approval.ok ? undefined : approval.problem.code, "requires_user_confirmation");

  const token = /approval\.token="([^"]+)"/.exec(approval.ok ? "" : approval.problem.message)?.[1];
  assert.ok(token, "requires_user_confirmation message must include approval.token");
  return {
    ...input,
    approval: {
      confirmed: true,
      token
    }
  };
}

function mockRoutedFetch(calls: FetchCall[]): void {
  // Route by path instead of a shift-queue: the concurrent-booking test runs
  // two createBooking flows that interleave on the event loop, so a fixed
  // response order can't predict which flow pulls which response. Each path
  // returns a stable response and any number of times, so the buggy (double
  // booking) path completes and is observed as two create calls rather than
  // failing on an exhausted queue.
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init as FetchCall["init"] });

    if (url.pathname === "/v1/appointments/create") {
      return jsonResponse({ data: { id: "appt_1", status: "CONFIRMED" } });
    }
    if (url.pathname.startsWith("/v1/services/")) {
      return jsonResponse({ data: serviceResponse() });
    }
    if (url.pathname.startsWith("/v1/salons/")) {
      return jsonResponse({ data: salonResponse() });
    }

    throw new Error(`unexpected fetch path: ${url.pathname}`);
  };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

function textResponse(status: number, statusText: string, body: string): Response {
  return new Response(body, { status, statusText });
}

function salonResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
    name: "Harbor Light Salon",
    currency: "USD",
    ...overrides
  };
}

function locationResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "schedule_1",
    name: "Studio",
    timezone: "America/Los_Angeles",
    ...overrides
  };
}

function serviceResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "service_1",
    title: "Haircut",
    duration: 60,
    price: 80,
    paymentRequirement: "NONE",
    ...overrides
  };
}
