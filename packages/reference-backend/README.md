# OSBP Reference Backend

Audience: OSBP adapter implementers and conformance-tool authors.

`@osbp/reference-backend` is OSBP's Layer-1 reference implementation: a self-hosted synthetic booking platform plus a vertical-neutral `SyntheticBookingAdapter`. It runs with zero credentials, no external network, and no live merchant data.

The point is generality. The adapter code is the same for every business. Vertical diversity lives in seed data:

| Organization | Region | Currency | Demonstrates |
|---|---:|---:|---|
| Carolyn's Dental | New York, US | USD | fixed-price bookings, insurance-dependent price, deposit, consultation handoff, no-show fee |
| Gus' Notary | New York, US | USD | same service id offered in person and online, quote-required price, Test Interface verification flow, deposit |
| Andy's Auto | Berlin, Germany | EUR | EU timezone handling, cancellation fee, quote/consultation branches, deposit |
| Phil's Spa | London, UK | GBP | UK timezone handling, full prepay, consultation branch, late/no-show policy, JPY zero-decimal money fixture |

## Run It

From the repo root:

```sh
npm run build --workspace @osbp/reference-backend
npm run smoke --workspace @osbp/reference-backend
npm run demo --workspace @osbp/reference-backend -- --now 2026-07-01T09:00:00Z
npm test --workspace @osbp/reference-backend
```

The smoke command starts the local synthetic HTTP server, targets each seeded organization with the adapter, runs read-only checks, prints a summary, and shuts the server down. No `.env` file is required.

The demo command runs the full mandate-gated booking flow against the same in-process synthetic backend. By default it narrates all four verticals plus an over-cap rejection coda; `--vertical dental|auto|notary|spa` renders one gallery cut. The current launch GIF uses `--launch --tape --gum` for a short Carolyn's Dental happy path that shows actual OSBP JSON requests/results plus the adapter-to-booking-platform GET/POST lines used to satisfy them. Pass `--now <RFC 3339 instant>` for deterministic dates and mandate expiry.

## Test Interface

The server exposes a controlled test endpoint for runtime branches:

```http
POST /test/scenarios
content-type: application/json

{
  "organization_id": "org_01jz7gmphxn33ertpvvx9y3yfh",
  "next_create": "requires_verification"
}
```

Supported `next_create` values are `requires_verification`, `slot_taken`, and `rate_limited`. Seeded services cover mandate-validation branches such as consultation handoff, required payment handoff, non-fixed prices, unknown payment requirements, price caps, currency mismatch, provider scope, schedule scope, and time-window scope.

Verification is also policy-driven when a service policy sets `verification_method` to `sms` or `email`: create without a code returns `requires_verification`, while a retry with the correct code books. The default four demo organizations keep service verification set to `none` so happy-path and fail-closed tests keep booking without a code.

## Conformance Fixture

The exported `REFERENCE_CONFORMANCE_ORGANIZATION` is a dedicated test fixture for `@osbp/conformance`. It is deliberately unlike the four demo verticals: one synthetic organization covers USD, EUR, GBP, JPY, and KWD prices, non-fixed prices, consultation, payment handoff branches, unknown payment, policy-driven verification, option duration shape, and parallel bookings of the canonical fixture slot. It is not included in `REFERENCE_ORGANIZATIONS`, so the default smoke command still prints only the four demo verticals.

## Online Appointments

Gus' Notary intentionally models in-person notarization and remote online notarization as peer schedules for the same `notary_document` service id. The online schedule is a `LocationSchedule` named `Online (remote notarization)` with no `address`, `latitude`, or `longitude`, but it still has the business timezone `America/New_York`.

That absence-of-address signal is workable for v0.1.0, but it is implicit. v0.2.0 should decide whether OSBP needs an explicit modality signal so agents do not have to infer online vs in-person from missing location fields.

## Platform Metadata (the ideal case)

The reference is also the IDEAL platform for observability and versioning, so the full `UpstreamMeta` / audit drift-provenance path runs end to end here (a minimal real-platform API sends almost none of it and cannot). Every response carries the complete header set OSBP asks real platforms for:

- `Server` (an infrastructure fingerprint),
- `api-version` (the applied version echoed on every response, the Square pattern),
- a unique `x-request-id` (the per-call correlation handle),
- `RateLimit` and `RateLimit-Policy`.

As at least one concrete lifecycle example, the availability read additionally returns `Deprecation` ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)) and `Sunset` ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)) headers. The `SyntheticBookingAdapter` captures all of this into `upstreamMeta`, which an OSBP host records into audit events. This is the worked example of the platform improvements OSBP requests of real platforms; a real, minimal platform sets `Deprecation`/`Sunset` only on an endpoint it is actually retiring.
