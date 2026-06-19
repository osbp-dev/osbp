# @osbp/conformance

Audience: adapter authors and reviewers validating an OSBP v0.1.0 `BookingAdapter`.

`@osbp/conformance` is a credential-free conformance kit for the OSBP v0.1.0 adapter contract. It drives any `BookingAdapter` through the public `@osbp/core` interface and returns a structured `ConformanceReport` with stable check ids, human-readable requirements, and `spec_ref` links back to the v0.1.0 spec.

The default target is synthetic and local. It uses no network, credentials, or environment variables:

```sh
npm run build --workspace=packages/osbp-conformance
node packages/osbp-conformance/dist/cli.js
node packages/osbp-conformance/dist/cli.js --json
```

A passing run prints a PASS certificate line:

```text
PASS 44/44 checks passed (0 failed, 0 skipped)
```

The package test suite also runs the full 44-check battery against `@osbp/reference-backend` using that package's dedicated `REFERENCE_CONFORMANCE_ORGANIZATION`. That cross-check keeps the default CLI target decoupled while proving the Layer-1 reference backend conforms to the same adapter contract.

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
  organization_id: "org_123",
  schedule_id: "sched_123",
  provider_id: "prov_123",
  date: "2030-05-02",
  time: "10:00",
  customer: { id: "cust_123", phone: "+15555550100" },
  services: {
    fixed_usd: "svc_fixed",
    fixed_eur: "svc_eur",
    fixed_gbp: "svc_gbp",
    fixed_jpy: "svc_jpy",
    fixed_kwd: "svc_kwd",
    insurance_dependent: "svc_insurance",
    quote_required: "svc_quote",
    consultation: "svc_consultation",
    deposit: "svc_deposit",
    full_prepay: "svc_full_prepay",
    unknown_payment: "svc_unknown_payment",
    verification: "svc_verification"
  },
  expected_prices: {
    svc_fixed: { amount_minor: 9500, currency: "USD" },
    svc_eur: { amount_minor: 9000, currency: "EUR" },
    svc_gbp: { amount_minor: 8000, currency: "GBP" },
    svc_jpy: { amount_minor: 12000, currency: "JPY" },
    svc_kwd: { amount_minor: 12500, currency: "KWD" }
  }
};
```

## What It Checks

The kit validates published envelope, Problem, mandate, and tool-input schemas; field shapes for `Service`, `Slot`, `Policy`, `Booking`, `Receipt`, and `Money`; the time-discipline split between offset-bearing instants and merchant-local wall-clock strings; mandate fail-closed problem codes; idempotency replay and conflict behavior; verification retry behavior; controlled runtime branches; and a full create -> status -> receipt happy path.

Each check has a stable `id` and `spec_ref`. The JSON report is intended for CI and for conformance evidence that can be read against `docs/spec/v0.1.0/README.md` and `schema.md`.

## Scope and Limitations

A PASS certifies that an adapter fails closed across the negative matrix (the mandate, idempotency, verification, and runtime-branch checks each assert an exact problem code) and completes the create -> status -> receipt happy path. It does not, by construction, prove that the adapter invoked `validateMandate` on the success path: an adapter that authorized the happy-path booking without consulting the mandate would still pass the positive check, because that fixture is in scope. Treat conformance as necessary, not sufficient. Pair it with a code review confirming that every mutation path calls `validateMandate` before the platform create call, which is the server-side obligation the spec places on the adapter or host.

This is a limitation of the conformance kit's coverage, not of OSBP's safety model: mandate enforcement is a spec obligation (`validateMandate` must run before every mutation), and the reference backend exercises it on every path. A future kit version (targeted for v0.2.0) adds a randomized positive boundary case so a success path that skipped the validator is more likely to fail a check.

The four published JSON schemas under `schemas/v0.1.0/` are verified in use by this kit: every schema check above runs a real payload against the published file, so a malformed or incorrect schema fails conformance. A separate generator-consistency check (that the published JSON matches its Zod source of truth) runs in the full development workspace, where that source lives; it is not part of this cut, so treat the shipped schemas as pinned v0.1.0 artifacts verified by use.
