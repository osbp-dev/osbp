The Open Service Booking Protocol (OSBP) is a small, open protocol that lets an AI agent book a service appointment only inside a user-approved authorization called a `BookingMandate`. The agent can search, compare, and prepare freely; it can mutate only inside the mandate. OSBP authorizes the booking, not the payment.

The v0.1.0 proof model is a provider-bound appointment timeslot: usually one provider's time, one schedule/location, one duration, and one booking policy, with inventory that must not be double-sold. OSBP models that narrow object directly for this release. The merchant's booking platform remains the system of record; OSBP validates authority, translates tool calls, and audits what happened.

This document is the complete v0.1.0 contract: the participants, the mandate, the eight tools and their wire shapes, the result envelope and error codes, the enforcement rules, and the audit trail. The key words *must*, *must not*, *should*, and *may* are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119): *must* is an absolute requirement, *should* a strong recommendation with rare justified exceptions, *may* a true option. Platform integrators should read [Core Objects](#core-objects) and the [Adapter Contract](#adapter-contract) first; agent builders should start with [BookingMandate](#bookingmandate) and the [Tool Set](#tool-set).

v0.1.0 proves the smallest useful OSBP loop:

```
BookingMandate → lookup → policy readback → create → verification if required → status → receipt
```

## Participants

| Participant | Role |
|---|---|
| Customer | The human principal: approves the mandate and the final slot, and supplies the verification code when required. In v0.1.0 the authorizing user and the customer are usually the same person |
| AI agent | Converts the customer's intent into a scoped `BookingMandate` and calls OSBP tools. OSBP is host-agnostic at the protocol boundary, and v0.1.0 ships the local stdio MCP path first. Hosts that can launch local MCP tools can fill this role without a host-specific OSBP API |
| OSBP server | Exposes the eight booking tools and records audit events. A conforming OSBP implementation validates mandate scope before mutation; in the reference implementation the adapter performs that validation before create |
| Platform adapter | Translates OSBP calls into the booking platform's API, and platform responses into OSBP results |
| Booking platform | Merchant system of record for services, availability, and appointments |

In v0.1.0 the OSBP server and the adapter run as a single local process beside the agent; OSBP provides the protocol core and server, and a platform integrator implements the adapter. The booking platform stays the system of record: OSBP never holds booking truth of its own; it authorizes, translates, and audits.

## Canonical Flow

The happy path runs lookup, policy readback, explicit approval, then mutation:

```
Customer
  → AI agent
  → MCP tool call
  → OSBP server / adapter boundary (mandate validation before mutation, audit at tool boundary)
  → platform adapter
  → booking platform API
  → normalized OSBP result
  → receipt and audit response to the agent
```

In tool terms: `service.describe` → `availability.find` → `policy.explain` → `booking.create` validation preflight with no platform appointment create → explicit user approval of the returned summary → `booking.create` approved retry → `booking.status`. The agent must read the policy impact back to the user before any mutation, and must ask before booking.

Final confirmation is an adapter-side gate. The reference adapter uses `requireApproval` in `@osbp/core`; other v0.1.0 adapters must enforce equivalent behavior. A valid `booking.create` call without `approval` returns `requires_user_confirmation` before any platform appointment create call. This gate exists to force the resolved service, merchant-local time, price, and policy into a user-visible summary, so the concrete booking is understood and authorized by the user before the platform sees an appointment-create mutation. Provider and location scope are pinned by ids and should be shown with display names when the adapter can resolve them safely. The challenge-form problem message carries both a user-facing approval summary and a machine-directed retry instruction. That retry instruction must embed the token exactly as `approval.token="<token>"`, so agents, audit redactors, and conformance checks can recognize it without parsing free prose. The agent must show only the approval summary to the user, get final confirmation, then retry `booking.create` with the same `idempotency_key` and `approval`.

Verification is agent-mediated. The server never sees a code except to pass it through:

```
booking.create
  → adapter requires final confirmation → requires_user_confirmation (retryable, no appointment created)
  → agent shows the approval summary and asks the customer to confirm
  → booking.create retried with the same idempotency_key plus approval
  → platform requires verification → requires_verification (retryable)
  → verification.send
  → agent asks the customer for the code out of band
  → booking.create retried with the same idempotency_key plus verification_code
```

Product posture: v0.1.0 defines no cancellation tool, so every create is irreversible within the protocol; for an agent, a clarifying question is always cheaper than a mutation made in doubt.

## Non-Goals

v0.1.0 does not include:

- merchant search or marketplace behavior
- a generic adapter framework
- slot holds
- modification, cancellation, or reconfirmation
- payment collection, payment authorization, deposits, refunds, or card handling
- production mandate signing
- public conformance certification
- concurrent multi-tenant hosting (one server instance serving multiple users or organizations at once)
- classes, group capacity, multi-attendee bookings, multi-resource reservations, route/dispatch visits, waitlists, or recurring series

## Protocol Model

The concepts every tool call shares: the domain objects, the mandate that authorizes mutation, and the money and time conventions they obey.

### Internationalization Strategy

OSBP v0.1.0 is global-ready at the protocol boundary, not a server-side localization system. The wire carries canonical machine-readable values: ISO 4217 currency codes and minor units, IANA timezones, RFC 3339 instants, merchant-local wall-clock strings, ISO 8601 durations, ISO weekday numbers, E.164 phone numbers, RFC 5322/RFC 6531 email addresses, and ISO 3166-1 country codes. The agent or host localizes presentation for the user from those canonical values.

Server-generated prose in v0.1.0 is English and carries no language tag: `Problem.message`, approval summaries, `Receipt.text`, and policy prose such as `cancellation_note` are explanatory text, not locale-specific UI. Agents conversing with a user in another language should translate that prose faithfully while preserving amounts, merchant-local times, and the merchant-visible customer name exactly as returned; they must not carry the machine-directed retry instruction or approval token into user-facing text. This is an implemented strategy for scaling internationally without adding server-side translations to the proof of concept; it is not a broad compatibility or global production-support promise.

### Core Objects

- **Organization**: the merchant (a clinic, a studio, a workshop). Identified by `organization_id`, the id the mandate is anchored to.
- **Schedule**: a bookable calendar or platform-specific availability container. In the v0.1.0 proof topology, the `schedule_id` a slot carries is the create-ready id and may also pin the location or provider, depending on the platform's native model.
- **Provider**: the person or staff resource whose time the slot binds.
- **Service**: the thing being booked, with duration, price, and payment requirements. `Service.options` may expose variants or add-ons for display and agent reasoning, but v0.1.0 `booking.create` has no option selector. An agent must not claim that an option or add-on was booked unless the selected `service_id` itself represents that exact bookable service. If the user asks for an option that cannot be represented in the create payload, the safe v0.1.0 behavior is to stop, ask whether they want the base service instead, or hand off.
- **Slot**: one bookable appointment opening in the v0.1.0 topology: a service, a provider, a start time, and a price. The start is carried twice: an absolute RFC 3339 instant in `starts_at` and the merchant-local wall-clock in `starts_at_local`.
- **Customer**: the person the appointment is for, whether or not any payment is involved. Usually the same human as the user approving the mandate, but the roles are distinct: the user authorizes, the customer attends. Customer phone numbers use [E.164](https://www.itu.int/rec/T-REC-E.164) format ("+15555550100"); email addresses are plain [RFC 5322](https://www.rfc-editor.org/rfc/rfc5322) addresses. Both pass through to the platform, which is the enforcer of its own contact formats. Customer names are intentionally light: `display_name` is the human-readable name to show the user, while optional `given_name` and `family_name` are available only for platforms that require separate fields. OSBP does not enforce a legal-name match or reject nicknames such as "Alex" for "Alexander"; it must not invent missing name parts either. If an adapter needs separate name fields and the input is ambiguous, it fails closed or asks for clarification. If a name is supplied, final confirmation should show the merchant-visible name so transposed or surprising fields can be caught before create.
- **Booking** and **Receipt**: the created appointment and OSBP's proof of creation. The platform's appointment record stays authoritative.

The tool examples below show populated shapes. Full field definitions, optionality, and TypeScript types live in the repository's [schema document](https://github.com/osbp-dev/osbp/blob/main/docs/spec/v0.1.0/schema.md).

### BookingMandate

The mandate is the user's scoped authorization. In v0.1.0 it is unsigned JSON; the server still validates every field before any mutation.

```json
{
  "id": "mnd_2026_05_01_001",
  "expires_at": "2026-05-01T23:59:59-07:00",
  "allowed_actions": ["booking.create"],
  "organization_id": "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
  "service_ids": ["service_123"],
  "provider_ids": ["provider_123"],
  "schedule_ids": ["schedule_123"],
  "earliest_start": "2026-05-01T09:00:00",
  "latest_end": "2026-05-14T18:00:00",
  "max_price": { "amount_minor": 10000, "currency": "USD" },
  "allow_policy_fee": false,
  "max_extra_fee": { "amount_minor": 0, "currency": "USD" }
}
```

- `expires_at` is an absolute instant and must carry `Z` or an explicit UTC offset. Naked wall-clock strings are rejected: they would parse in the host's local timezone and could expire hours early or late.
- `earliest_start` and `latest_end` are wall-clock strings in the merchant's local time, with no offset. They are compared against `Slot.starts_at_local` and `Slot.ends_at_local`, which follow the same convention.
- `service_ids`, `provider_ids`, and `schedule_ids` are optional. A looser mandate authorizes a wider booking funnel; a stricter mandate pins one service, one provider, one schedule. Omit one of these fields to leave that dimension unconstrained; an empty array is a present but empty allow-list and allows nothing. The ids must constrain the actual create-ready ids used for `booking.create`, not display labels.

### Money

Every money-bearing value is a `Money` object, never a bare integer: `{ amount_minor?, currency, type?, display? }`. The money-bearing fields are `Service.price`, `ServiceOption.price`, `Slot.price`, `Policy.deposit`, `BookingMandate.max_price`, and `BookingMandate.max_extra_fee`.

`amount_minor` is an integer in the currency's [ISO 4217](https://www.iso.org/iso-4217-currency-codes.html) minor unit. The minor-unit exponent varies by currency: USD and EUR use 2 places, JPY, CLP, and VND use 0, and KWD, JOD, and TND use 3. It is not always cents, so adapters scale by the currency's exponent, not a fixed factor of 100. For any currency an adapter supports, the exponent must come from current ISO 4217 or CLDR currency data, or from a dated, reviewed snapshot of that data, rather than an unexplained local shortlist; a merchant currency whose exponent is unknown is not safe to onboard. `currency` is the ISO 4217 code and is required whenever a `Money` is present, so cross-currency comparisons fail closed instead of guessing. `type` defaults to `fixed` when an amount is present; the non-fixed values `insurance_dependent`, `quote_required`, and `unknown` mark a price with no fixed `amount_minor` known at read time. `display` is an optional locale-formatted string such as "$95.00": a best-effort, non-canonical hint. Agents should reformat `amount_minor` plus `currency` in the end user's locale rather than parse the `display` string, and implementations never parse it. Use `amount_minor` for arithmetic and mandate checks.

Adapters must normalize the platform's native money representation into `amount_minor`: a platform that reports major units (for example 80 meaning $80.00) is scaled by the currency's minor-unit exponent, while a platform whose amounts are already minor units is passed through unscaled. Misreading the native unit yields prices wrong by a factor of the currency's exponent.

OSBP never converts currencies implicitly. If a selected service, slot, or policy is in a different currency than the mandate cap, the server fails closed with `currency_mismatch` and asks for a new user approval. A selected price without a fixed `amount_minor` fails closed with `requires_user_confirmation`.

### Time Discipline

A concrete slot or booking time is carried two ways at once, so a reader gets both the canonical absolute moment and the value the merchant platform stores:

- **Absolute instants** (`starts_at`, `ends_at` on `Slot` and `Booking`): an [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) instant carrying `Z` or an explicit offset (for example "2026-05-05T20:00:00Z"). This is the canonical, cross-vertical form: FHIR, Google, Square, Cal.com, and Zocdoc all key concrete appointment times to instants. The adapter computes it from the merchant-local wall-clock plus the schedule's IANA timezone. Compare instants only against other instants.
- **Merchant-local wall-clock, no offset** (`starts_at_local`, `ends_at_local` on `Slot` and `Booking`; mandate `earliest_start` and `latest_end`; the `date` and `time` of `booking.create`): a string like "2026-05-05T13:00:00" with no offset, interpreted in the merchant's timezone. That timezone is carried as `Slot.schedule_timezone` / `Booking.schedule_timezone` using [IANA Time Zone Database](https://www.iana.org/time-zones) names (for example "America/Los_Angeles"). Agents must use the IANA timezone, not the street address, for wall-clock reasoning. These are the values that round-trip into `booking.create`.
- **Other absolute instants**: mandate `expires_at` and audit `created_at` are also RFC 3339 instants.

OSBP carries the absolute instant (the adapter computes it from merchant-local time plus the merchant's IANA timezone) but does not reconcile the user's own timezone with merchant-local time; reconciling the user's local intent ("book me 2pm my time") with the merchant's wall-clock is the agent's job before it ever populates `date`/`time` or `earliest_start`/`latest_end`. There is no user-timezone field in the protocol, and `starts_at` is the merchant's instant, not the user's.

The split is deliberate. The wall-clock fields (`starts_at_local`, `ends_at_local`, `earliest_start`, `latest_end`, `date`, `time`) are intentionally not RFC 3339. Implementations, including generated ones, must not "fix" them by adding `Z` or a UTC offset, and must not strip the offset off the instant fields; the server rejects offset-carrying wall-clock values as `invalid_mandate`, and the instant fields must carry an offset.

The merchant-local wall-clock is authoritative for the platform round-trip, so the adapter always emits it and derives the absolute instant from it. The reference adapter is wall-clock-native, so it converts merchant-local time to the instant with a small, DST-correct helper and leaves `starts_at` absent rather than guessing when the schedule timezone is unknown. A platform that is instant-native instead converts the other direction (instant to merchant wall-clock for `date`/`time` on `booking.create`); naive truncation (slicing the offset off a UTC string) silently books the UTC wall-clock hour, wrong by the merchant's offset. An illustrative merchant-local-to-instant conversion:

```ts
// Merchant-local wall-clock (no offset) -> UTC RFC 3339 instant, via the schedule IANA tz.
function wallClockToInstant(localISO: string, timeZone: string): string {
  const guessUTC = new Date(`${localISO}Z`).getTime();
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(guessUTC)).map((x) => [x.type, x.value]));
  const asTz = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guessUTC - (asTz - guessUTC)).toISOString();
}
```

Where operating hours appear (`schedule_hours` on slots and locations), `day` is an ISO 8601 weekday number, 1 = Monday through 7 = Sunday, not the JS `getDay` convention (0 = Sunday); the adapter converts the platform's value. `open` and `close` are wall-clock "HH:MM" strings in the location's timezone. A `close` value earlier than `open` means the period continues into the following calendar day, for example `20:00` to `02:00`. Hours are typical display context only; `availability.find` is the authority for bookable time. Durations (`Service.duration`, `Policy.cancellation_window`, `Policy.late_grace`) are ISO 8601 duration strings such as "PT45M", not bare integers.

## Wire Format

How OSBP speaks: the transport it rides, what the tools are named, and the envelope every result uses.

### Transport

OSBP rides the [Model Context Protocol](https://modelcontextprotocol.io) rather than defining its own transport. v0.1.0 binds the tool set to a local stdio MCP server; tool results are returned as compact JSON text plus MCP structured content. Remote transport and authentication are not part of v0.1.0.

### Naming

Protocol-level tool names are dotted:

```
service.describe
availability.find
policy.explain
verification.send
verification.verify
booking.create
booking.status
handoff.request
```

MCP tool names are flattened:

```
osbp_service_describe
osbp_availability_find
osbp_policy_explain
osbp_verification_send
osbp_verification_verify
osbp_booking_create
osbp_booking_status
osbp_handoff_request
```

### Result Envelope

Every tool returns one envelope shape. Success:

```json
{
  "ok": true,
  "value": { },
  "audit_event_id": "aud_..."
}
```

Failure:

```json
{
  "ok": false,
  "problem": {
    "code": "price_exceeds_mandate",
    "message": "Selected service or slot price exceeds BookingMandate.max_price",
    "retryable": false
  },
  "audit_event_id": "aud_..."
}
```

`osbp_runtime` is optional diagnostics for agents and operators. It describes how this response was produced, not durable booking truth. In v0.1.0 the only defined value is `idempotency: "local_cache_replay"`, used when an adapter returns a settled result from local OSBP idempotency state instead of calling the booking platform again:

```json
{
  "osbp_runtime": {
    "idempotency": "local_cache_replay",
    "message": "No platform create call was made; this result was replayed from local OSBP idempotency state."
  }
}
```

`problem.code` is the stable machine-readable contract. `problem.message` is explanatory English prose in v0.1.0, not a parsing target; branch on `problem.code` only.

The codes in use:

| Code | Meaning |
|---|---|
| `invalid_mandate` | Mandate is missing required fields, `expires_at` lacks an explicit timezone, or a wall-clock field carries an offset |
| `mandate_expired` | Mandate `expires_at` is in the past |
| `action_not_allowed` | Tool is not in `allowed_actions` |
| `organization_not_allowed` | Organization is outside mandate scope |
| `service_not_allowed` | Service is outside mandate scope |
| `schedule_not_allowed` | Schedule is outside mandate scope |
| `provider_unknown` | Slot does not identify provider required by mandate scope |
| `provider_not_allowed` | Provider is outside mandate scope |
| `slot_too_early` | Slot starts before `earliest_start` |
| `slot_too_late` | Slot ends after `latest_end` |
| `price_exceeds_mandate` | Price exceeds `max_price` |
| `policy_fee_exceeds_mandate` | Required fee exceeds `max_extra_fee` |
| `currency_mismatch` | Selected price currency does not match the mandate cap currency; fail closed for new user approval |
| `requires_payment_handoff` | Mandate does not allow a required payment or policy fee |
| `requires_consultation_handoff` | Service requires a consultation/quote workflow that v0.1.0 cannot drive; route to `handoff.request` |
| `requires_user_confirmation` | Either final confirmation is required, or a payment requirement or amount is unknown. The final-confirmation challenge is retryable and includes an approval token; the fail-closed validator form is not retryable and carries no token |
| `requires_verification` | Platform requires customer verification before booking (retryable) |
| `verification_failed` | The submitted verification code was rejected (wrong or expired); retry the send step and then retry `booking.create` with the new raw code |
| `slot_taken` | The selected slot is no longer available (retryable) |
| `idempotency_conflict` | Same `idempotency_key` reused with a different payload |
| `booking_not_found` | No appointment matches the status query |
| `booking_status_requires_verification` | Appointment history is gated behind a verification step that read tools cannot complete. Rely on the `booking.create` receipt or hand off |
| `rate_limited` | Upstream returned HTTP 429. Back off and retry (retryable) |
| `internal_adapter_error` | An adapter threw unexpectedly; the host caught it and recorded an audited Problem rather than leaking the throw |

Adapters may emit additional adapter-specific codes, for example `missing_config` or `invalid_verification_purpose`. The codes above are the protocol-meaningful set.

## Tool Set

### `service.describe`

Returns the service facts the agent needs to explain a bookable service.

**Input**

```json
{
  "service_id": "service_123"
}
```

`service_id` is optional; the adapter may substitute its configured default service.

**Output**

```json
{
  "ok": true,
  "value": {
    "id": "service_123",
    "name": "Haircut",
    "duration": "PT60M",
    "price": { "amount_minor": 9500, "currency": "USD", "type": "fixed", "display": "$95.00" },
    "requires_consultation": false
  },
  "audit_event_id": "aud_..."
}
```

When `requires_consultation` is true, booking this service routes to a merchant-side approval queue instead of creating an appointment. Agents must surface this to the user before `booking.create`.

### `availability.find`

Returns candidate slots for one service, schedule, and date.

**Input**

```json
{
  "service_id": "service_123",
  "schedule_id": "schedule_123",
  "date": "2026-05-05",
  "provider_id": "provider_123"
}
```

`date` is a wall-clock date in the merchant's local time. `service_id` and `schedule_id` are optional; the adapter may substitute configured defaults so an agent can ask "what's open tomorrow" without discovering ids first. `provider_id` is optional.

**Output**

```json
{
  "ok": true,
  "value": [
    {
      "id": "schedule_123:provider_123:service_123:2026-05-05T13:00:00",
      "organization_id": "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      "schedule_id": "schedule_123",
      "schedule_name": "Main Studio",
      "schedule_timezone": "America/Los_Angeles",
      "provider_id": "provider_123",
      "provider_name": "Jordan Lee",
      "service_id": "service_123",
      "starts_at": "2026-05-05T20:00:00.000Z",
      "ends_at": "2026-05-05T21:00:00.000Z",
      "starts_at_local": "2026-05-05T13:00:00",
      "ends_at_local": "2026-05-05T14:00:00",
      "price": { "amount_minor": 9500, "currency": "USD", "type": "fixed", "display": "$95.00" }
    }
  ],
  "audit_event_id": "aud_..."
}
```

Each slot carries the create-ready `organization_id`, `schedule_id`, `provider_id`, and `service_id`, so an agent can build a `booking.create` call and its mandate scope directly from the selected slot. `starts_at` is the absolute instant (here 13:00 `America/Los_Angeles` = 20:00Z); `starts_at_local` is the merchant-local wall-clock and round-trips into `booking.create` `date` and `time` unchanged.

There is no slot-hold mechanism in v0.1.0. OSBP must never claim a slot is held before booking is confirmed.

### `policy.explain`

Returns payment and cancellation policy facts before `booking.create`.

**Input**

```json
{
  "service_id": "service_123"
}
```

**Output**

```json
{
  "ok": true,
  "value": {
    "service_id": "service_123",
    "cancellation_enabled": true,
    "cancellation_window": "PT6H",
    "cancellation_note": "Cancel at least 6 hours before the appointment.",
    "late_grace": "PT15M",
    "cancellation_fee": { "amount_minor": 2500, "currency": "USD", "type": "fixed", "display": "$25.00" },
    "no_show_fee": { "amount_minor": 5000, "currency": "USD", "type": "fixed", "display": "$50.00" },
    "payment_requirement": "none",
    "deposit": { "amount_minor": 0, "currency": "USD" },
    "verification_method": "sms",
    "organization": {
      "id": "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
      "name": "Bayview Hair Studio",
      "timezone": "America/Los_Angeles",
      "currency": "USD",
      "country": "US"
    }
  },
  "audit_event_id": "aud_..."
}
```

`payment_requirement` is `"none" | "deposit" | "full_prepay" | "unknown"`. If it is `"deposit"` or `"full_prepay"`, v0.1.0 still does not collect payment. A booking may proceed only when the required amount is fixed and explicitly allowed by the mandate (`allow_policy_fee: true`); if the mandate also provides `max_extra_fee`, that cap must be same-currency and cover the amount. Otherwise `booking.create` returns `requires_payment_handoff` or another fail-closed `Problem`. If it is `"unknown"`, the server fails closed with `requires_user_confirmation`.

`cancellation_fee` and `no_show_fee` are surfaced (each a `Money` object) when the platform exposes them, so an agent can show the user the conditional liability of a booking; even a free service can carry a no-show fee. They appear only when the platform reports a fee amount, and are omitted otherwise. Agents must include any surfaced cancellation or no-show fee in the final user-visible approval summary, and must not describe those fees as capped by the `BookingMandate`. OSBP v0.1.0 does not yet enforce or cap them through the mandate: that is roadmap, tied to payment composition.

The `organization` block surfaces the merchant's canonical id, since agents construct the mandate's `organization_id` from a read tool, and the timezone and currency the agent needs for wall-clock and price reasoning. `country` is an [ISO 3166-1 alpha-2](https://www.iso.org/iso-3166-country-codes.html) code.

`verification_method` reports the method OSBP can identify for the platform flow. The v0.1.0 enum is `sms`, `email`, `none`, or `unknown`; future methods such as voice or messaging apps should be additive. Agents should not promise a more specific channel than OSBP reports.

### `verification.send`

Sends a verification code after `booking.create` returns `requires_verification`.

**Input**

```json
{
  "customer": {
    "phone": "+15555550100",
    "email": "jane@example.com"
  },
  "purpose": "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w"
}
```

`purpose` follows the convention `booking:{organization_id}`.

**Output**

```json
{
  "ok": true,
  "value": {
    "sent": true,
    "method": "sms",
    "purpose": "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w"
  },
  "audit_event_id": "aud_..."
}
```

### `verification.verify`

Verifies a code for non-booking flows that require explicit pre-verification. In the v0.1.0 booking flow, the agent normally supplies the raw code to `booking.create` after `requires_verification`, and the adapter lets the platform verify and consume it during appointment creation.

Agents MUST NOT call this before `booking.create` when the adapter documents that pre-verification consumes the booking code, challenge, or session. Adapters that lack a safe independent verify primitive should reject this tool with an adapter-specific `Problem` rather than attempting to simulate it. If a platform has an independent pre-verification primitive that does not consume the booking attempt, the adapter may support it for non-booking flows and must document whether it applies to booking.

**Input**

```json
{
  "customer": {
    "phone": "+15555550100",
    "email": "jane@example.com"
  },
  "purpose": "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w",
  "code": "123456"
}
```

**Output**

```json
{
  "ok": true,
  "value": {
    "verified": true,
    "method": "sms",
    "purpose": "booking:org_01jw3z8x9k2m4n6p8r0s1t3v5w"
  },
  "audit_event_id": "aud_..."
}
```

The agent must ask the customer for the code out of band. OSBP must not invent, suppress, or bypass verification.

Verification codes are sent by the merchant platform and may arrive in the platform's language and channel-specific wording. Agents should tell the user only the method OSBP reported and should not promise text-message wording, sender names, or language that OSBP did not receive.

### `booking.create`

Creates the appointment after user approval and mandate validation. Every booking mutation must include a `BookingMandate` and an `idempotency_key`.

**Input**

```json
{
  "mandate": {
    "id": "mnd_2026_05_01_001",
    "expires_at": "2026-05-01T23:59:59-07:00",
    "allowed_actions": ["booking.create"],
    "organization_id": "org_01jw3z8x9k2m4n6p8r0s1t3v5w",
    "service_ids": ["service_123"],
    "provider_ids": ["provider_123"],
    "schedule_ids": ["schedule_123"],
    "earliest_start": "2026-05-01T09:00:00",
    "latest_end": "2026-05-14T18:00:00",
    "max_price": { "amount_minor": 10000, "currency": "USD" },
    "allow_policy_fee": false,
    "max_extra_fee": { "amount_minor": 0, "currency": "USD" }
  },
  "idempotency_key": "idem_2026_05_01_001",
  "service_id": "service_123",
  "schedule_id": "schedule_123",
  "provider_id": "provider_123",
  "date": "2026-05-05",
  "time": "13:00",
  "customer": {
    "id": "customer_123",
    "display_name": "Jane Customer",
    "given_name": "Jane",
    "family_name": "Customer",
    "phone": "+15555550100",
    "email": "jane@example.com"
  },
  "approval": {
    "confirmed": true,
    "token": "approve_opaque_adapter_token"
  },
  "verification_code": "123456"
}
```

`date` and `time` are wall-clock values in the merchant's local time, taken from the selected slot's `starts_at_local`.

The first call for a logical booking attempt omits `approval`. The adapter validates the mandate and slot, then the approval gate returns `requires_user_confirmation` with an exact booking summary and an adapter-issued `approval.token`, and does not call the platform create endpoint. The summary is user-facing prose, not a dump of protocol enum labels; for example, say "No upfront payment or deposit is required to book" instead of `payment_requirement: none`. The message then carries a machine-directed retry instruction containing the token, formatted exactly as `approval.token="<token>"`; the agent must not display that token to the user. After the user confirms the summary, retry with the same payload, same `idempotency_key`, and `approval: { "confirmed": true, "token": "<returned token>" }`. The approval token is bound to the exact pending payload, including the `idempotency_key`, and to the resolved summary the user saw. If resolved facts such as price or policy text change before the retry, the adapter re-challenges with a fresh summary instead of accepting the old token. A token expires after a short TTL; the reference gate uses ten minutes. A leaked token cannot authorize a different booking, a different payload, or a second create under a new idempotency key.

The same `requires_user_confirmation` code is also used by mandate validation when a booking cannot be safely bounded, such as unknown payment requirements or non-fixed amounts. That fail-closed form is terminal for v0.1.0: it is not retryable and carries no `approval.token`. Agents must not invent a token or retry it as a final-confirmation challenge; explain the blocking fact and route to `handoff.request`.

If the booking input includes a customer name, the approval summary should show the merchant-visible name that will be sent to the platform. This catches common agent mistakes, such as swapped `given_name` / `family_name`, without creating a new OSBP-level identity gate. If the platform accepts "Alex Smith", OSBP should not fail the booking merely because the user's formal name might be "Alexander Smith"; if the platform rejects the contact/name pair, the adapter maps that platform rejection to a `Problem`.

A failed approved attempt may still leave non-appointment side effects on the booking platform, such as a create-or-find customer record or a verification message, before the final appointment create succeeds or fails. The final-confirmation gate guarantees no platform appointment create happens before approval; it is not a promise that every failed attempt is invisible to the merchant system.

`verification_code` is supplied only on retry after `requires_verification`.

**Output**

```json
{
  "ok": true,
  "value": {
    "id": "receipt_idem_2026_05_01_001",
    "booking_id": "appointment_123",
    "text": "Booked Haircut on 2026-05-05 at 13:00. Appointment id: appointment_123."
  },
  "audit_event_id": "aud_..."
}
```

If the platform requires customer verification after the approved retry, `booking.create` fails with `requires_verification` (retryable). The agent then calls `verification.send`, asks the user for the code, and retries `booking.create` with the same `idempotency_key`, the same `approval`, and the raw `verification_code`.

The agent generates a fresh `idempotency_key` for each logical booking attempt and reuses it only when retrying that same attempt. `approval` and `verification_code` are transient fields and are excluded from the local payload hash. A successful create is cached: retrying with the same key and payload returns the same receipt without contacting the platform again. The same key with a different payload fails with `idempotency_conflict`.

### `booking.status`

Reads appointment state. The `booking_id` is the one returned in the create receipt. When the platform exposes a direct appointment read, adapters should use it for status answers that claim current platform state. A local record may be used as a documented fallback or receipt-snapshot path, including immediately after an OSBP-created booking when the adapter's integration notes say the answer is cache-first; such a response must not pretend to be fresh platform state. When the platform's only readback is gated behind a verification step a read flow cannot complete, the adapter fails closed with `booking_status_requires_verification` rather than guessing. `customer` is accepted so an adapter that can read history may match by contact details.

**Input**

```json
{
  "booking_id": "appointment_123",
  "customer": {
    "phone": "+15555550100"
  }
}
```

**Output**

```json
{
  "ok": true,
  "value": {
    "id": "appointment_123",
    "status": "booked",
    "service_id": "service_123",
    "schedule_id": "schedule_123",
    "provider_id": "provider_123",
    "starts_at": "2026-05-05T20:00:00.000Z",
    "starts_at_local": "2026-05-05T13:00:00",
    "schedule_timezone": "America/Los_Angeles"
  },
  "audit_event_id": "aud_..."
}
```

### `handoff.request`

Fallback when the adapter cannot safely complete the request. Use when:

- payment or deposit collection is required before confirming
- the selected slot disappeared
- the request exceeds mandate scope
- verification fails, expires, or rate-limits
- the platform API returns an ambiguous state

**Input**

```json
{
  "reason": "requires_payment_handoff",
  "message": "This service requires a deposit. Please complete the booking with the merchant directly.",
  "mandate_id": "mnd_2026_05_01_001"
}
```

**Output**

```json
{
  "ok": true,
  "value": {
    "status": "requires_human",
    "reason": "requires_payment_handoff",
    "message": "This service requires a deposit. Please complete the booking with the merchant directly.",
    "mandate_id": "mnd_2026_05_01_001"
  },
  "audit_event_id": "aud_..."
}
```

`handoff.request` has no side effect: nothing is sent to the merchant. It returns a structured `requires_human` result for the agent to relay to the user, and the call is audited like any other schema-valid tool call. Merchant-side delivery of handoffs is out of scope for v0.1.0. The freeform `reason` and `message` fields must not carry customer names, contact details, or addresses; use opaque ids and non-identifying status text.

## Server Obligations

What a conforming OSBP server must do on every booking mutation, regardless of platform.

### Mandate Enforcement

Before `booking.create`, OSBP must verify, in order:

- the mandate has an id and a well-formed `expires_at` with an explicit timezone
- the mandate is not expired
- `booking.create` is included in `allowed_actions`
- the organization, service, schedule, and provider are all inside scope
- `earliest_start`, `latest_end`, and the slot's `starts_at_local`/`ends_at_local` are wall-clock strings without offsets, while the slot's `starts_at`/`ends_at` are absolute RFC 3339 instants (mixed conventions on the wall-clock fields are rejected as `invalid_mandate`), and the slot start and end fall inside the mandate window
- the price currency matches `max_price.currency` and the amount is at or below `max_price.amount_minor`; a currency mismatch fails closed with `currency_mismatch`
- the service does not require a consultation/quote workflow (fails closed with `requires_consultation_handoff`)
- any required payment or policy fee is allowed by `allow_policy_fee`, matches the `max_extra_fee` currency, and is at or below `max_extra_fee.amount_minor`; unknown payment requirements fail closed with `requires_user_confirmation`
- final confirmation is present before any platform appointment create; the reference adapter enforces this through the shared `@osbp/core` approval gate, which returns an approval token from a prior validated no-write `booking.create` call
- the same `idempotency_key` returns the same result if retried; the same key with a different payload fails with `idempotency_conflict`, while transient `approval` and `verification_code` fields do not create a new logical attempt

OSBP idempotency lives in the local adapter cache. The audit log must store the mandate id and enough mandate content to explain each decision.

### Audit

Every schema-valid tool call that reaches the OSBP tool handler produces a local audit event carrying redacted input and result snapshots plus stable hashes for later correlation:

```json
{
  "id": "aud_...",
  "mandate_id": "mnd_2026_05_01_001",
  "tool_name": "booking.create",
  "created_at": "2026-05-05T20:00:00.000Z",
  "source": "osbp-local-mcp",
  "input": { },
  "result": { },
  "input_hash": "3f2a...",
  "result_hash": "9c41..."
}
```

`input_hash` and `result_hash` are hex SHA-256 digests of the redacted snapshots.

Audit is also the operator-observability channel for upstream platform drift. Each event MAY carry `platform` (the adapter's static identity) and `upstream` (response metadata from the most recent upstream call observed during the tool call). `upstream` is absent when the tool answered locally, for example an idempotency-cache hit or `handoff.request`. The shapes:

```ts
interface PlatformIdentity {
  vendor: string      // stable platform slug
  api_version: string // the exact native API pin the adapter sends or encodes
}

interface UpstreamMeta {
  call: string        // "METHOD /path"; query strings omitted, contact-bearing segments redacted
  status: number
  server?: string     // Server header, verbatim; an infrastructure fingerprint, not a version
  request_id?: string // first response header whose name contains "request-id"
  api_version?: string // response-side API version echo when the platform sends one
  deprecation?: string // Deprecation header (RFC 9745), verbatim
  sunset?: string      // Sunset header (RFC 8594), verbatim HTTP-date
  ratelimit?: Record<string, string> // Retry-After, RateLimit, RateLimit-Policy, X-RateLimit-*, keyed lowercase
}
```

These are operator-observability fields, never agent-facing booking output, and they carry no customer data by construction.

The server appends redacted JSONL audit events to `.osbp/audit/events.jsonl` by default; set `OSBP_AUDIT_LOG_PATH` to override. Audit events must redact structured customer contact and name fields, provider image URLs, verification codes, approval tokens, contact-shaped phone/email strings in free text, and known sensitive strings discovered from structured input. Freeform tool text cannot reliably identify arbitrary names or addresses that appear nowhere else in structured input, so agents must not put those details in `handoff.request` `reason` or `message`. Checked-in traces must use audit aliases rather than raw local audit records.

## Security and Privacy Considerations

OSBP's threat model includes the agent itself. An agent can be over-eager, confused, or compromised, so booking-create authorization is enforced server-side against the user-approved mandate; the agent is never trusted to self-limit. v0.1.0 mandates are unsigned JSON, which is a stated limitation, not a design goal: production mandate signing is a non-goal for this version and a requirement for any version that drops the "proof of concept" label. Verification tools are side-effecting but are not mandate-gated in v0.1.0; the limitation is called out below.

- **Durable secrets stay server-side.** Anything placed in a prompt, tool input, tool result, `Problem.message`, or agent-facing transcript can be shown to the user, retained by the host, or copied into a debug session. Durable secrets such as platform API keys, OAuth bearer tokens, refresh tokens, merchant dashboard credentials, and platform-private override flags must stay in adapter/server config and must never be routed through the agent.
- **Attempt-scoped capabilities are tolerated, not trusted.** Approval tokens and verification codes may pass through the agent only to complete the v0.1.0 booking loop. They must be scoped as narrowly as the platform allows, one-time-use where possible, short-lived, redacted from audit events and published traces, and insufficient by themselves to bypass mandate validation. Where a platform cannot provide one of those properties, for example a verification code scoped to a merchant rather than one booking attempt, the adapter documentation must say so.
- **Correlation identifiers are not durable secrets.** Mandate ids, idempotency keys, booking ids, receipt ids, and audit event ids exist so the user, adapter, and operator can correlate one attempt. They may appear in receipts, audit events, and agent-visible output. Their sensitivity inherits the platform's readback and challenge semantics: where a platform offers unauthenticated by-id readback or keys a verification purpose to an appointment id, treat booking ids as sensitive in published traces and logs even though they are not platform credentials.
- **Verification is sacred.** OSBP must not invent, suppress, or bypass customer verification. Raw codes pass through to the platform and are never persisted; the audit log records that verification happened and by which method, never the code.
- **Audit events are redacted.** Structured customer contact and name fields, provider image URLs, verification codes, approval tokens, contact-shaped phone/email strings in free text, and known sensitive strings discovered from structured input are redacted before writing. Freeform handoff text must not carry customer names, contact details, or addresses that are not also present in structured fields. Checked-in traces must use audit aliases rather than raw local records.
- **Fail closed.** Unknown payment requirements, unknown fee amounts, and ambiguous platform states refuse or hand off rather than proceed. A mutation that cannot be explained to the user does not happen.
- **No platform overrides.** OSBP must never set platform-private flags that skip availability, verification, or payment checks, even when the platform exposes them.
- **Caller identity is self-declared in v0.1.0.** When OSBP calls the booking platform it identifies itself with self-declared HTTP headers only: a `User-Agent` (for example `OSBP/0.1.0 reference-backend/0.1.0 node/24`) and an `x-osbp-source` marker. This is not authentication, and a platform must not treat either as proof of origin. v0.1.0 propagates no verifiable agent or end-user identity to the platform, and the mandate is validated structurally, not cryptographically. Verifiable request signing (for example HTTP Message Signatures, RFC 9421) and OAuth resource-server authorization for a remote MCP server are roadmap items, not v0.1.0 guarantees.
- **No circumventing platform fairness controls.** Beyond not overriding checks, OSBP must never bypass, disable, or evade a platform's rate limits, queueing, per-user or per-account booking limits, waitlists, or anti-bot controls. OSBP traffic is subject to the same allocation, rate-limit, and safety controls the platform applies to native users. In v0.1.0 this is a conduct requirement, not an enforced one, since caller identity is self-declared: it states the conformance bar that verifiable identity later makes checkable.
- **Payment authority is a separate layer.** OSBP authorizes the booking, not the payment. A `BookingMandate` is designed to compose alongside payment-mandate protocols; when a booking requires payment, OSBP hands off instead of handling the charge.

## Known Limitations (Proof of Concept)

v0.1.0 proves the authorization loop, not a production trust surface. These limitations are deliberate, and naming them is part of the contract: an integrator must not mistake the proof of concept for a hardened system. The incentive risks below are real even though nothing is exploiting them yet, and several are exactly the parts an adversarial agent or a careless integration would lean on.

- **Narrow appointment topology.** v0.1.0 models a single-attendee, single-provider appointment slot with no exposed capacity, room/equipment allocation, route stop, recurring series, waitlist position, or class roster. An adapter for a platform whose real booking object depends on one of those dimensions must fail closed or hand off rather than flattening the missing dimension into a misleading v0.1.0 slot.
- **Idempotency is local and ephemeral.** Deduplication of `booking.create` lives in an in-process cache backed by a local file, keyed by `idempotency_key` and payload-hashed. It does not survive a multi-instance deployment, a cross-session replay, or an adapter restart with a cleared store. A production deployment needs durable, platform-enforced idempotency; until then a buggy or adversarial caller can produce duplicate bookings the local cache cannot catch.
- **Final confirmation is adapter-side.** The shared `@osbp/core` approval gate (`requireApproval`, used by the reference adapter) requires a short-lived approval token before the platform appointment-create endpoint is called, which prevents a single accidental `booking.create` call from booking immediately. It cannot prove the human saw or approved the summary, because the token still flows through the agent. The user-facing summary and the machine-directed retry instruction also share one `Problem.message`, so v0.1.0 relies on agent guidance to show only the summary; audit logs and published traces redact tokens, but a live chat can still expose them if an agent pastes the whole message. Because the token flows through the agent and a mandate is reusable until `expires_at`, a compromised agent can self-approve repeated creates within the mandate's scope. v0.1.0 has no per-mandate booking count cap. A production deployment needs a host/server confirmation primitive outside the agent's unilateral control.
- **Verification-code pass-through is a platform accommodation, not a recommended pattern.** The reference booking flow has the agent relay a raw SMS or email code through `booking.create`. OSBP never persists the code, and the audit log records only that verification happened and by which method. But routing a raw human-delivered code through the agent at all is a concession to a platform's current API, not a design to copy. Some platforms scope codes to a merchant and customer rather than to one booking attempt, so a leaked code remains useful for the platform TTL. Out-of-band or signed verification, where the agent never handles the raw code, is the intended direction.
- **Merchant-supplied text is untrusted display data.** Service names, provider names, organization names, cancellation notes, and receipt text may originate in a merchant-controlled booking platform and flow into the agent context. v0.1.0 does not authenticate, sanitize, fence, or label those strings as untrusted content. Agents and hosts must treat them as display data, not instructions; a production host should add stronger tool-result labeling or content isolation.
- **`verification.send` is not mandate-gated.** The tool can dispatch a real SMS or email to a caller-supplied contact and is bounded only by platform rate-limit and safety controls in v0.1.0. The protocol does not yet bind the send destination to the customer of a pending gated booking attempt; a production version needs that binding or a mandate-scoped contact allowlist.
- **No slot holds: booking a scarce slot is a first-come race.** OSBP holds no slot and the platform is the system of record, so the first completed `booking.create` wins. When provider time is scarce a fast agent can win that race against a human on native UI, and it is sharper mid-booking when a deposit or verification step sits between selecting a slot and confirming it. v0.1.0 has no hold or lease, and no optimistic-concurrency token (`availability_snapshot_id`) to make a stale attempt fail cleanly. These are roadmap items (contention controls).
- **No fairness, fee-cap, or signed-receipt mechanisms.** v0.1.0 has no allocation-policy disclosure, no conformance tiers, and no handoff-volume or unknown-rate metrics. An agent that repeatedly probes availability or fires handoffs is neither rate-limited nor measured by the protocol. Receipts and availability snapshots are unsigned, so neither the user nor the merchant gets a tamper-evident record of what was authorized or offered.
- **Cancellation and no-show fees are surfaced but not capped by the mandate.** `Policy.cancellation_fee` and `Policy.no_show_fee` let an agent show the conditional liability of a booking, but the mandate does not yet cap them or require reapproval when they change. A booking can carry a fee the user was shown without the mandate ever bounding it. Today the protection is explicit disclosure in final approval, not enforcement.
- **`provider_image_url` is a likeness and is not anonymized in tool results.** The field is a URL to a provider's display image, frequently a photograph of a named person. OSBP surfaces it on every `Slot` and does not redact or alias it in ordinary tool responses. The local audit logger redacts this key, and the checked-in trace redactor omits it by explicit allowlist. A raw availability response, or an integrator who widens a trace allowlist, exposes a named person's image URL. Treat it as personal data when deciding what a trace, log, or downstream store may contain.

## Implementing OSBP

The integrator path: the contract to implement, how to run the reference, and what a correct end-to-end trace contains.

### Adapter Contract

OSBP reaches a booking platform through one interface. Implementing OSBP for your platform means implementing these seven methods:

```ts
interface AdapterRuntimeDiagnostics {
  idempotency?: "local_cache_replay"
  message?: string
}

type AdapterResult<T> =
  | { ok: true; value: T; osbp_runtime?: AdapterRuntimeDiagnostics }
  | { ok: false; problem: Problem; osbp_runtime?: AdapterRuntimeDiagnostics }

interface BookingAdapter {
  // Static platform identity and most-recent upstream response metadata,
  // recorded into audit events. See Platform Metadata and Versioning.
  readonly platform?: PlatformIdentity
  readonly upstreamMeta?: UpstreamMeta
  describeService(input: ServiceDescribeInput): Promise<AdapterResult<Service>>
  findAvailability(input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>>
  explainPolicy(input: PolicyExplainInput): Promise<AdapterResult<Policy>>
  sendVerification(input: VerificationSendInput): Promise<AdapterResult<VerificationChallenge>>
  verifyCode(input: VerificationVerifyInput): Promise<AdapterResult<VerificationChallenge>>
  createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>>
  getBooking(input: BookingStatusInput): Promise<AdapterResult<Booking>>
}
```

Adapters translate platform behavior into OSBP results and raise gaps explicitly. Canonical protocol policy (the mandate validator, the fail-closed rules) comes from the protocol core (`validateMandate` in `@osbp/core`) and is not the adapter's to relax. Mandate validation is a server-side obligation that must run before the platform mutation; it may live in the host layer or inside the adapter. In the reference implementation the adapter performs it: `createBooking` fetches the service and policy, builds the `Slot`, and calls `validateMandate` before issuing any create call. The reference host does not re-validate, so a `createBooking` that assumes the host validates would ship no enforcement at all: call the validator yourself unless your host does. Booking idempotency lives in the adapter's local cache.

### Platform Metadata and Versioning

An adapter MUST declare its platform identity statically:

```ts
readonly platform: PlatformIdentity = { vendor: "osbp-reference-backend", api_version: "v1" }
```

`api_version` is the exact native pin the adapter sends or encodes: a version request header value (for example `Square-Version: 2026-05-21`), a media-type version parameter, or the version segment of the base URL for path-versioned APIs. When the platform supports request-side pinning, the adapter MUST send the pin on every request and MUST NOT rely on account or dashboard defaults, which can change outside the adapter's control. When the platform exposes no version mechanism, the adapter SHOULD record the documented spec version (for example OpenAPI `info.version`), its source, and the retrieval date in a source comment; that is build-time provenance, not a runtime signal, and drift detection falls to the read-only smoke.

Contract-drift monitoring is adapter-owned and platform-native, not a universal OSBP protocol shape. An adapter SHOULD add a scheduled drift monitor only when the platform offers a stable, official, non-PII-bearing contract source to diff and a clear operator action when the diff changes. A public OpenAPI document, a dated version echo, a generated client, a path version, an evolvable-enum policy, and a closed SDK all imply different monitoring strategies. Do not require an OpenAPI baseline or watcher from adapters whose platforms cannot support one, and do not substitute scraping, dashboard automation, or private endpoints for an official contract source.

For each upstream response the adapter SHOULD capture, into the audit channel: the method and path (query strings omitted, contact-bearing path segments redacted), the HTTP status, the `Server` header, the first header whose name contains `request-id`, any response-side API version echo, the `Deprecation` header ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)), the `Sunset` header ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)), and `Retry-After` / RateLimit headers. The `Server` value is an infrastructure fingerprint, frequently the CDN or edge-proxy build rather than the platform application, and MUST NOT be presented as an application or API version.

If a response carries `Deprecation` or `Sunset`, the adapter MUST surface it loudly on the operator channel, at least once per endpoint per process, so an operator learns the upstream is retiring before it breaks. A lifecycle announcement is not a failure: the call succeeded, so it MUST NOT become a `Problem` and MUST NOT change agent-facing output.

The reference backend is an in-process, unauthenticated loopback server, which is unusual; most real platforms require an API key or OAuth bearer. Put platform credentials in the adapter config (from the environment, never hard-coded), attach them in the single request helper alongside the `User-Agent`, and keep them out of observability: `captureUpstreamMeta` records response headers only, and credentials MUST NOT appear in `UpstreamMeta`, audit events, or `Problem` messages.

A platform-neutral sketch of the pattern:

```ts
const platform = { vendor: "example", api_version: "2026-05-21" } as const;

async function upstreamFetch(method: string, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    method,
    headers: {
      ...init.headers,
      "user-agent": `OSBP/${OSBP_VERSION} ${platform.vendor}/${OSBP_VERSION} node/${process.versions.node.split('.')[0]}`,
      // Send the native pin exactly where the platform requires it.
      "example-version": platform.api_version
    }
  });

  const meta = captureUpstreamMeta(`${method} ${path}`, response);
  recordForAudit({ platform, upstream: meta });

  if (meta.deprecation || meta.sunset) {
    warnOperatorOncePerEndpoint(meta);
  }

  return response;
}
```

The reference adapter in the repository implements this pattern; its internal `captureUpstreamMeta` helper is the worked capture function.

### Getting Started

- [Reference implementation](https://github.com/osbp-dev/osbp): TypeScript monorepo with the protocol core, the credential-free synthetic reference backend, the conformance kit, and an adapter starter.
- [Run the demo](https://github.com/osbp-dev/osbp/tree/main/packages/reference-backend): `npm run demo` books a synthetic appointment inside a `BookingMandate`, then shows the guardrail rejecting an over-cap booking, with no account or secrets.
- [Trace gallery](https://github.com/osbp-dev/osbp/tree/main/traces): replayable credential-free reference traces, from user request through mandate, tool calls, guardrails, and receipt.

### Demo Trace

A complete reference trace includes, in order:

1. user request
2. generated `BookingMandate`
3. `service.describe`
4. `availability.find`
5. `policy.explain`
6. `booking.create` validation preflight without `approval`
7. explicit user approval text using the returned summary
8. `booking.create` retry with `approval`
9. `verification.send` (if required), followed by retry of `booking.create` with the same `approval` plus `verification_code`
10. `booking.status`
11. final receipt returned to the user
12. local audit event ids
