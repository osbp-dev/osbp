# Implementing An OSBP Adapter

Audience: booking-platform developers and AI coding agents implementing a v0.1.0 `BookingAdapter`.

This guide is the adapter on-ramp for OSBP v0.1.0. Start from `packages/adapter-starter`, map one method at a time against the target platform API, and use `packages/osbp-conformance` as the grader for a synthetic or sandbox target until every requirement id is green.

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
3. Replace the env names in `src/conformance-target.ts` with target-platform fixture and config names.
4. Run `npm run build`, then run the adapter's conformance CLI against a fixture target that can safely exercise the mutation branches:

```sh
node packages/<your-adapter>/dist/cli.js --conformance
```

5. Read the failing requirement ids.
6. Implement the smallest method slice that can flip one group of ids.
7. Repeat until the report is green.

The unimplemented starter should fail. That is the point: it returns typed `AdapterResult` Problems with code `adapter_not_implemented` rather than throwing or fabricating data. Progress is visible as failing requirement ids move to pass.

For a live booking platform, the conformance target may be a sandbox merchant or a small synthetic mirror of that platform's semantics. The v0.1.0 fixture matrix assumes deterministic verification and fixed multi-currency services; a production account that sends real OTPs or supports only one merchant currency should not be forced to create unsafe real bookings or fabricate data just to satisfy the generic battery. Pair the conformance report with a live read-only smoke and a redacted trace for the platform itself.

## Copy-Paste Safety

The starter is a skeleton, not a universal adapter framework. When copying it,
make operator policy explicit and keep platform-specific decisions in the copied
adapter:

- Do not ship shared or live platform defaults in public adapters. Require the
  operator to provide `apiBaseUrl`, merchant/account ids, and credentials through
  config or env.
- Keep public docs and examples on placeholders and `.example` values. Do not
  publish shared demo tenants as the default path.
- Configure `httpTimeoutMs` for outbound requests. Timeouts are adapter config,
  not hidden process behavior.
- Put auth and native API/version pins in config/env. Do not bury API keys,
  bearer tokens, version headers, media-type pins, or path-version choices in
  hardcoded helper code.
- Treat `nativeApiVersion` in the starter as a copy-paste marker only. Replace
  it with the target platform's real version header, media type, or path segment;
  do not build a broad cross-platform version abstraction.
- Gate any live customer/contact fallback behind an explicit boolean such as
  `enableConfiguredCustomerFallback`. A configured fallback can help an operator
  bridge a platform requirement, but it is not identity proof and should move to
  the host/auth boundary in production.
- Omit platform notification flags by default. If a platform sends SMS, email,
  customer, or merchant notifications, expose an operator-approved config choice
  or deliberately omit the field when the platform supports omission. Never
  hardcode notification behavior because the sample adapter happened to do it.
- Fail closed when required booking truth is missing. Do not invent service,
  provider, schedule, price, customer identity, policy, verification, or payment
  facts to satisfy a create endpoint.

## Platform Versions and Drift

Treat platform contract evidence as adapter-owned and platform-native. Every
adapter should declare the native platform version it targets and capture
response metadata, but OSBP does not require every adapter to implement the same
drift watcher shape.

Use the strongest official evidence the platform actually provides:

- a dated request/version-echo model, such as Square, should be pinned and checked
  through that native header model;
- a per-endpoint version model, such as Cal.com, needs endpoint-specific pins and
  smoke coverage for the endpoints the adapter uses;
- a path-versioned API, such as Microsoft Graph, should record the path version
  and monitor the platform's own release/deprecation signals;
- a generated-client or closed-SDK platform should be treated as doc- or
  SDK-derived until a sandbox run verifies the wire behavior;
- a platform with no supportable public booking API should not get a scraping,
  dashboard-automation, or private-endpoint adapter just to satisfy a checklist.

Add a scheduled drift monitor only when there is a stable, official,
non-PII-bearing contract source to diff and a clear operator action when it
changes. A drift watcher is a worked guardrail when a platform publishes an
OpenAPI document and echoes a version header. It is not a protocol requirement
and should not be copied blindly into future adapters. If a platform lacks a
comparable source, rely on static `platform.api_version`, upstream metadata
capture, read-only smoke checks, and live verification notes instead.

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

Key rules: `organization.id` must be reachable through a read result so an agent can build `BookingMandate.organization_id`; unknown payment state fails closed; deposits and full prepay route to payment handoff unless the required amount is fixed and explicitly allowed by `BookingMandate.allow_policy_fee`. When `max_extra_fee` is present, the cap must be same-currency and cover the amount. OSBP v0.1.0 does not collect payment.

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

Expected platform failures return `AdapterResult` Problems, never thrown
rejections. Map upstream HTTP 429 to retryable `rate_limited` so agents get the
portable back-off signal. Keep raw upstream bodies, exception messages, stacks,
customer contacts, and credentials out of `Problem.message`; if an adapter logs
operator diagnostics, log only redacted path/status metadata or a sanitized error
name.

Customer identity should make legitimate bookings easier, not create a new OSBP paperwork gate. If the platform accepts the supplied customer name/contact, OSBP should not reject it merely because it might be a nickname or informal form. But an adapter must not invent name parts to satisfy a platform's required `firstName` / `lastName` fields. Use explicit `given_name` / `family_name` when available. Use `display_name` only when the platform can accept a display name, or when an adapter-specific fallback split is mechanically unambiguous. A whitespace split is mechanically unambiguous only for exactly two tokens; three or more tokens can represent double surnames, particles, or family-name-first orders and must return a clear `Problem` or ask for clarification instead. Final confirmation should include the merchant-visible customer name when one is supplied, so swapped or surprising name fields are visible before the platform create call.

Treat every value the agent can see as potentially user-visible or transcript-persistent. Keep durable secrets, such as platform API keys, OAuth tokens, refresh tokens, merchant credentials, and platform-private override flags, in adapter/server config only. Attempt-scoped capabilities, such as approval tokens and raw verification codes, may flow through the agent only when scoped as narrowly as the platform allows, one-time-use where possible, short-lived, redacted from audit events and published traces, and unable to bypass `validateMandate`. Correlation identifiers, such as mandate ids, idempotency keys, booking ids, receipt ids, and audit event ids, are not durable secrets, but their sensitivity inherits the platform's readback and challenge semantics.

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

The reference backend may seed additional services beyond the required conformance set. It currently includes CLP and JOD money fixtures to exercise zero- and three-decimal exponent coverage without making those currencies mandatory for every adapter's conformance fixture.

If the platform cannot safely create real bookings in CI, use a sandbox merchant or a target-specific test interface. Do not make production bookings just to satisfy conformance. If the platform is single-currency or uses real one-time verification codes, keep the live proof to read-only smoke plus a redacted trace, and run the mutation-heavy conformance battery against a safe mirror.

## Done

An adapter is ready for review when:

- `npm run build` passes;
- `node packages/<your-adapter>/dist/cli.js --conformance` passes against a safe sandbox or synthetic target that mirrors the platform's booking semantics;
- live-platform read-only smoke and a redacted trace cover the real API surfaces the adapter uses;
- no method throws for expected platform failures;
- every mutation path validates `BookingMandate` before the platform create call;
- platform credentials and private override controls never appear in prompts, tool results, `Problem.message`, traces, or audit snapshots;
- traces and logs redact credentials, verification codes, approval tokens, live ids, and customer contact details.
