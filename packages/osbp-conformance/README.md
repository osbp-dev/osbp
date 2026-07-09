# @osbp/conformance

Audience: adapter authors and reviewers validating an OSBP v0.1.0 `BookingAdapter`.

`@osbp/conformance` is a credential-free conformance kit for the OSBP v0.1.0 adapter contract. It drives any `BookingAdapter` through the public `@osbp/core` interface and returns a structured `ConformanceReport` with stable check ids, human-readable requirements, and `spec_ref` links back to the v0.1.0 spec.

The default target is synthetic and local. It uses no network, credentials, or environment variables:

```sh
npm run build --workspace=packages/osbp-conformance
node packages/osbp-conformance/dist/cli.js
node packages/osbp-conformance/dist/cli.js --json
```

A passing run prints a PASS summary line:

```text
PASS <passed>/<total> checks passed (0 failed, 0 skipped)
```

The package test suite also runs the full check battery against `@osbp/reference-backend` using that package's dedicated `REFERENCE_CONFORMANCE_ORGANIZATION`. That cross-check keeps the default CLI target decoupled while proving the Layer-1 reference backend conforms to the same adapter contract.

## Using Your Adapter

Point the CLI at a built module that exports one of:

- `adapter`: a `BookingAdapter` instance
- `default`: a `BookingAdapter` instance or factory
- `createAdapter()`: a factory returning a `BookingAdapter`
- `createBookingAdapter()`: a factory returning a `BookingAdapter`

```sh
node packages/osbp-conformance/dist/cli.js --target ./dist/my-adapter.js
node packages/osbp-conformance/dist/cli.js --target ./dist/my-adapter.js --json
```

For deterministic runtime branches such as `slot_taken` and `rate_limited`, export `createConformanceAdapter(mode)` or `createScenarioAdapter(mode)`. The mode is one of `normal`, `slot_taken`, or `rate_limited`. If no scenario factory is provided, those controlled checks are skipped.

If your fixture ids differ from the synthetic defaults, export `conformanceFixtures`:

```ts
export const conformanceFixtures = {
  organization_id: "org_01jz8b9m6qf3v2n7s4t5w6x8y9",
  schedule_id: "sched_01jz8ba0h4k6m9p2r7s3t5v8w1",
  provider_id: "prov_01jz8ba6d2h5m8q1r4s7t9v0x3",
  date: "2030-05-02",
  time: "10:00",
  customer: { id: "cus_01jz8bab9p4r7s2t5v8w1x3y6z", phone: "+15555550100" },
  services: {
    fixed_usd: "svc_01jz8bb0a1c2d3e4f5g6h7j8k9",
    fixed_eur: "svc_01jz8bb6b2d3e4f5g6h7j8k9m0",
    fixed_gbp: "svc_01jz8bbc3d4e5f6g7h8j9k0m1n",
    fixed_jpy: "svc_01jz8bbj4e5f6g7h8j9k0m1n2p",
    fixed_kwd: "svc_01jz8bbq5f6g7h8j9k0m1n2p3q",
    insurance_dependent: "svc_01jz8bbw6g7h8j9k0m1n2p3q4r",
    quote_required: "svc_01jz8bc27h8j9k0m1n2p3q4r5s",
    consultation: "svc_01jz8bc88j9k0m1n2p3q4r5s6t",
    deposit: "svc_01jz8bce9k0m1n2p3q4r5s6t7v",
    full_prepay: "svc_01jz8bcmam1n2p3q4r5s6t7v8w",
    unknown_payment: "svc_01jz8bctbn2p3q4r5s6t7v8w9x",
    verification: "svc_01jz8bd0cp3q4r5s6t7v8w9x0y"
  },
  expected_prices: {
    svc_01jz8bb0a1c2d3e4f5g6h7j8k9: { amount_minor: 9500, currency: "USD" },
    svc_01jz8bb6b2d3e4f5g6h7j8k9m0: { amount_minor: 9000, currency: "EUR" },
    svc_01jz8bbc3d4e5f6g7h8j9k0m1n: { amount_minor: 8000, currency: "GBP" },
    svc_01jz8bbj4e5f6g7h8j9k0m1n2p: { amount_minor: 12000, currency: "JPY" },
    svc_01jz8bbq5f6g7h8j9k0m1n2p3q: { amount_minor: 12500, currency: "KWD" }
  }
};
```

## What It Checks

The kit validates published envelope, Problem, mandate, and tool-input schemas; field shapes for `Service`, `Slot`, `Policy`, `Booking`, `Receipt`, and `Money`; the time-discipline split between offset-bearing instants and merchant-local wall-clock strings; mandate fail-closed problem codes; Problem messages that do not echo fixture phone/email contact values; idempotency replay and conflict behavior; verification retry behavior, including wrong-code rejection; controlled runtime branches; and a full create -> status -> receipt happy path.

Each check has a stable `id` and `spec_ref`. The JSON report is intended for CI and for conformance evidence that can be read against `docs/spec/v0.1.0/README.md` and `schema.md`.

## Scope and Limitations

A PASS means every check that ran passed. Skipped checks certify nothing and are listed in the report summary. The line is conformance evidence for the adapter contract, not live-platform certification.

The negative matrix checks fail-closed mandate, final approval, idempotency, verification, and runtime-branch behavior by asserting exact problem codes where those checks run. The kit does not, by construction, prove that the adapter invoked `validateMandate` on the success path: an adapter that authorized the happy-path booking without consulting the mandate would still pass the positive check, because that fixture is in scope. It also does not fully verify approval-summary content, semantic agreement between wall-clock times and absolute instants, or external currency-exponent evidence beyond the declared fixture prices. Treat conformance as necessary, not sufficient. Pair it with a code review confirming that every booking-create path calls `validateMandate` before the platform create call, which is the server-side obligation the spec places on the adapter or host.

This is a limitation of the conformance kit's coverage, not of OSBP's safety model: mandate enforcement is a spec obligation (`validateMandate` must run before every booking-create mutation), and the reference backend exercises it on every create path. A future kit version (targeted for v0.2.0) adds a randomized positive boundary case so a success path that skipped the validator is more likely to fail a check.

The v0.1.0 battery is strongest against a synthetic or sandbox target that can mirror the fixture matrix. It assumes fixed multi-currency services, known schedule timezones, the narrow v0.1.0 appointment topology (one service, one provider/staff resource, one schedule/location, one attendee, no capacity dimension), and a deterministic verification-code path where `booking.create` returns `requires_verification`, `verification.send` sends a challenge, and an approved retry with a raw code creates the booking. Many live booking platforms are single-currency, deliver real OTPs, use independent pre-verification, have no OTP step, or cannot safely create bookings in CI. For those adapters, use conformance against a sandbox or target-specific synthetic mirror, then pair the live integration with read-only smoke checks and a redacted trace. Fixture profiles and explicit skips for other verification and topology shapes are deferred to v0.2.0; until then, a PASS is evidence for this concrete v0.1.0 shape, not certification for classes, group capacity, multi-resource bookings, route/dispatch flows, waitlists, or multi-attendee booking models.

The four published JSON schemas under `schemas/v0.1.0/` are verified in use by this kit: every schema check above runs a real payload against the published file, so a malformed or incorrect schema fails conformance. A separate generator-consistency check (that the published JSON matches its Zod source of truth) runs in the full development workspace, where that source lives; it is not part of this cut, so treat the shipped schemas as pinned v0.1.0 artifacts verified by use.
