# Implementing An OSBP Adapter

Audience: booking-platform developers and AI coding agents implementing a v0.1.0 `BookingAdapter`.

This guide is the adapter on-ramp for OSBP v0.1.0. Start from `packages/adapter-starter`, map one method at a time against the target platform API, and use `packages/osbp-conformance` as the grader until every requirement id is green.

## Starting Point

Use the actual package names from `package.json`:

- `@osbp/core`: `BookingAdapter`, domain types, `AdapterResult`, and `validateMandate`.
- `@osbp/reference-backend`: complete synthetic adapter and HTTP client structure.
- `@osbp/conformance`: `runConformance(adapter, options)`, the CLI, and stable requirement ids.
- `@osbp/adapter-starter`: compiling skeleton that returns `adapter_not_implemented` until mapped.

For AI-assisted implementation, build the single-file context bundle first:

```sh
node scripts/build-adapter-context.mjs
```

Then provide `dist/osbp-adapter-context.md` plus the target platform's API docs to the coding agent. The bundle is deterministic; `node scripts/build-adapter-context.mjs --check` verifies it is current.

## Implementation Loop

1. Copy `packages/adapter-starter/` to a new package for the target platform.
2. Rename the package and class, then set `platform.vendor` and `platform.api_version`.
3. Replace the env names in `src/conformance-target.ts` with target-platform fixture names.
4. Run `npm run build`, then run the adapter's conformance CLI:

```sh
node packages/<your-adapter>/dist/cli.js --conformance
```

5. Read the failing requirement ids.
6. Implement the smallest method slice that can flip one group of ids.
7. Repeat until the report is green.

The unimplemented starter should fail. That is the point: it returns typed `AdapterResult` Problems with code `adapter_not_implemented` rather than throwing or fabricating data. Progress is visible as failing requirement ids move to pass.

## Method Map

### `describeService`

Map the platform's service or product endpoint into `Service`.

Worked answers:

- `packages/reference-backend/src/index.ts`: `SyntheticBookingAdapter.describeService`

Conformance ids this helps satisfy:

- `shape.service.duration_iso8601`
- `shape.service.option_duration_iso8601`
- `shape.money.fixed_minor_units`
- `shape.money.jpy_minor_units`
- `shape.money.kwd_minor_units`
- `shape.money.non_fixed_absent_amount`

Key rules: durations are ISO 8601 strings such as `PT45M`; fixed prices use `Money.amount_minor` with the currency's ISO 4217 minor-unit exponent; non-fixed prices omit `amount_minor`; consultation or quote workflows set `requires_consultation`.

### `findAvailability`

Map the platform's availability endpoint into `Slot[]`.

Worked answers:

- `packages/reference-backend/src/index.ts`: `SyntheticBookingAdapter.findAvailability`

Conformance ids this helps satisfy:

- `shape.operating_hours.iso_weekday`
- `shape.slot.time_pair`
- `shape.slot.denormalized_context`
- `shape.ids.organization_booking`
- `time.instants_have_offsets`
- `time.wall_clock_no_offsets`

Key rules: `starts_at` and `ends_at` are RFC 3339 instants with an offset; `starts_at_local` and `ends_at_local` are merchant-local wall-clock strings without offsets; `schedule_timezone` is an IANA timezone; `OperatingHours.day` is ISO weekday 1 through 7. Include denormalized organization, schedule, provider, and location context when the platform provides it.

### `explainPolicy`

Map cancellation, late, payment, deposit, verification, and organization context into `Policy`.

Worked answers:

- `packages/reference-backend/src/index.ts`: `SyntheticBookingAdapter.explainPolicy`

Conformance ids this helps satisfy:

- `mandate.requires_user_confirmation.unknown_payment`
- `mandate.requires_payment_handoff.deposit`
- `mandate.requires_payment_handoff.full_prepay`
- `mandate.requires_consultation_handoff`
- `verification.required_then_code_books`

Key rules: `organization.id` must be reachable through a read result so an agent can build `BookingMandate.organization_id`; unknown payment state fails closed; deposits and full prepay route to payment handoff in v0.1.0.

### `sendVerification` and `verifyCode`

Map the platform's customer-verification endpoints.

Worked answers:

- `packages/reference-backend/src/index.ts`: `SyntheticBookingAdapter.sendVerification` and `verifyCode`

Conformance ids this helps satisfy:

- `verification.required_then_code_books`

Key rules: return `sent: true` only after the platform accepts the send; return `verified: true` only after the platform confirms the code; bad codes return `verification_failed` as an `AdapterResult` Problem.

### `createBooking`

Map the platform's create endpoint. This is the trust boundary.

Worked answers:

- `packages/reference-backend/src/index.ts`: `SyntheticBookingAdapter.createBooking`

Conformance ids this helps satisfy:

- `schema.problem.failure`
- `adapter.failure_result_no_throw`
- all `mandate.*` ids
- `idempotency.replay_same_payload`
- `idempotency.conflict_different_payload`
- `runtime.slot_taken`
- `runtime.rate_limited`
- `happy_path.create_status_receipt`

Key rules: resolve the selected service, slot, and policy; call `validateMandate` before any mutation; keep `idempotency_key` in a local cache unless the platform has an empirically verified native idempotency primitive; exclude `verification_code` from the logical-attempt hash; return a human-readable `Receipt` with `booking_id`.

### `getBooking`

Map direct appointment readback or a safe local OSBP-created booking snapshot.

Worked answers:

- `packages/reference-backend/src/index.ts`: `SyntheticBookingAdapter.getBooking`

Conformance ids this helps satisfy:

- `shape.booking.status_enum`
- `time.instants_have_offsets`
- `time.wall_clock_no_offsets`
- `happy_path.create_status_receipt`

Key rules: `Booking.status` is one of `booked`, `cancelled`, `completed`, `no_show`, `pending`, `unknown`; the platform stays the system of record; if a read path is verification-gated and the tool cannot complete that verification, fail closed instead of guessing.

## Fixture Strategy

The conformance kit needs fixtures that exercise the contract:

- one fixed-price service in each required currency shape: USD, EUR, GBP, JPY, KWD;
- one insurance-dependent service;
- one quote-required service;
- one consultation service;
- one deposit service;
- one full-prepay service;
- one unknown-payment service;
- one verification-required service;
- one provider, one schedule, one date/time, and one customer safe for test bookings.

If the platform cannot safely create real bookings in CI, use a sandbox merchant or a target-specific test interface. Do not make production bookings just to satisfy conformance.

## Done

An adapter is ready for review when:

- `npm run build` passes;
- `node packages/<your-adapter>/dist/cli.js --conformance` passes;
- no method throws for expected platform failures;
- every mutation path validates `BookingMandate` before the platform create call;
- traces and logs redact credentials, verification codes, live ids, and customer contact details.
