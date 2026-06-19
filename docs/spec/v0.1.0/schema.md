# OSBP v0.1.0 POC Schema

Audience: implementers and reviewers of the v0.1.0 MCP/tool schemas.

- **Status:** implementation-bound proof-of-concept schema
- **Compatibility:** not stable; no public compatibility promise

This document describes the schema currently used by the v0.1.0 proof-of-concept implementation. It is intentionally narrow: one agent host, one synthetic reference backend, one create-booking flow, local stdio MCP, and redacted local audit events.

Do not treat this as the long-term OSBP protocol schema. v0.2.0 may revise these shapes for remote MCP hosting, OpenAI/ChatGPT metadata, provider/location resolution, auth context, and multi-currency money objects.

## Protocol Model

The proof-of-concept schema is organized around the shared OSBP model: the domain objects, the `BookingMandate`, and the money and time conventions that every tool obeys.

### Core Objects

```ts
interface Money {
  // Integer amount in the currency's ISO 4217 minor unit. The exponent varies
  // by currency (USD and EUR use 2, JPY uses 0, KWD and BHD use 3), so it is not
  // always cents. Absent for type insurance_dependent, quote_required, or unknown.
  amount_minor?: number
  // ISO 4217 currency code, for example "USD". Required whenever a Money is present.
  currency: string
  // Defaults to "fixed" when an amount is present.
  type?: "fixed" | "insurance_dependent" | "quote_required" | "unknown"
  // Optional locale-formatted string, for example "$100.00". Non-canonical: never parse it.
  display?: string
}

interface Service {
  id: string
  name: string
  // ISO 8601 duration string, e.g. "PT45M". Not a bare integer of minutes.
  duration?: string
  // Service price as a Money object. Use price.amount_minor for arithmetic and
  // mandate checks; show price.display to the user.
  price?: Money
  // True when booking routes to a merchant-side approval queue instead of
  // creating an appointment. Mandate validation fails closed with
  // requires_consultation_handoff.
  requires_consultation?: boolean
  options?: ServiceOption[]
}

interface ServiceOption {
  id: string
  name?: string
  price?: Money
  // ISO 8601 duration string, e.g. "PT15M".
  duration?: string
}

interface LocationSchedule {
  id: string
  name?: string
  slug?: string
  address?: string
  // IANA timezone name interpreting the wall-clock strings in hours[].
  timezone?: string
  latitude?: number
  longitude?: number
  hours?: OperatingHours[]
}

// One open period for a weekday. Presence means open; a day with no entry is
// closed (no redundant flag). A day may repeat for split shifts.
interface OperatingHours {
  // ISO 8601 weekday: 1 = Monday through 7 = Sunday. Not JS getDay (0 = Sunday).
  day: number
  // Wall-clock HH:MM strings in the location's local time.
  open: string
  close: string
}

interface Slot {
  id: string
  organization_id?: string
  schedule_id: string
  schedule_name?: string
  schedule_address?: string
  schedule_latitude?: number
  schedule_longitude?: number
  schedule_hours?: OperatingHours[]
  // IANA timezone name. Authoritative for interpreting starts_at_local and
  // schedule_hours, and the tz the adapter used to compute starts_at.
  schedule_timezone?: string
  provider_id?: string
  provider_name?: string
  provider_image_url?: string
  provider_has_portfolio?: boolean
  service_id: string
  // Absolute RFC 3339 instant (carries Z or an explicit offset). Canonical
  // cross-vertical form, computed by the adapter from starts_at_local plus
  // schedule_timezone. Absent when the tz is unknown.
  starts_at?: string
  // Absolute RFC 3339 instant for the end, same convention as starts_at.
  ends_at?: string
  // Wall-clock ISO-like string in schedule_timezone, no offset. Deliberately
  // not RFC 3339. Round-trips into booking.create date/time. The instant
  // starts_at is derived from this.
  starts_at_local: string
  // Wall-clock ISO-like string in schedule_timezone, same convention as
  // starts_at_local.
  ends_at_local?: string
  // Slot price as a Money object. Use price.amount_minor for arithmetic and
  // mandate checks; show price.display to the user.
  price?: Money
  organization_name?: string
}

interface Policy {
  service_id?: string
  cancellation_enabled?: boolean
  // ISO 8601 duration string, e.g. "PT24H". Not a bare integer of hours.
  cancellation_window?: string
  cancellation_note?: string
  // ISO 8601 duration string, e.g. "PT15M".
  late_grace?: string
  // Fee for a late cancellation, when the platform exposes it. Surfaced so an
  // agent can show the conditional liability of a booking; even a free service
  // can carry one. Not yet enforced or capped through the mandate (roadmap).
  cancellation_fee?: Money
  // Fee for a no-show, when the platform exposes it. Same framing as
  // cancellation_fee: surfaced for awareness, not yet mandate-enforced.
  no_show_fee?: Money
  payment_requirement?: "none" | "deposit" | "full_prepay" | "unknown"
  // Required deposit as a Money object. Checked against max_extra_fee when
  // payment_requirement is "deposit".
  deposit?: Money
  verification_method?: "sms" | "email" | "unknown"
  organization?: OrganizationContext
}

interface OrganizationContext {
  // The organization's canonical id. Feeds BookingMandate.organization_id.
  id?: string
  name?: string
  slug?: string
  domain?: string
  phone?: string
  support_email?: string
  instagram_handle?: string
  timezone?: string
  currency?: string
  // ISO 3166-1 alpha-2 country code, for example "US".
  country?: string
  total_locations?: number
}

interface Customer {
  id?: string
  // E.164 phone number, for example "+15555550100". Passed through to the platform.
  phone?: string
  // RFC 5322 (or RFC 6531 for internationalized addresses) email address. OSBP
  // passes the value through; the platform enforces its own format.
  email?: string
  display_name?: string
}

interface Booking {
  id: string
  // Normalized lifecycle status from a closed enum; the adapter maps the
  // platform's native status onto it, defaulting unknown values to "unknown".
  status?: "booked" | "cancelled" | "completed" | "no_show" | "pending" | "unknown"
  service_id?: string
  schedule_id?: string
  provider_id?: string
  // Absolute RFC 3339 instant, computed from starts_at_local plus
  // schedule_timezone. Absent when the tz is unknown.
  starts_at?: string
  // Wall-clock ISO-like string in merchant-local time, no offset. The instant
  // starts_at is derived from this.
  starts_at_local?: string
  // IANA timezone name interpreting starts_at_local and used to compute
  // starts_at.
  schedule_timezone?: string
  customer_id?: string
}

interface Receipt {
  id: string
  text: string
  booking_id?: string
}
```

`Organization`, `Schedule`, `Provider`, `Service`, `Slot`, `Customer`, `Booking`, and `Receipt` have the semantics described in [README.md](README.md#core-objects). The customer and the authorizing user are usually the same human in v0.1.0, but the roles are distinct: the user authorizes, the customer attends.

### BookingMandate

```ts
interface BookingMandate {
  id: string
  // RFC 3339 instant with Z or an explicit UTC offset.
  expires_at: string
  allowed_actions: OsbpToolName[]
  organization_id: string
  service_ids?: string[]
  provider_ids?: string[]
  schedule_ids?: string[]
  // Wall-clock strings in merchant-local time, no offset. Deliberately not RFC 3339.
  earliest_start?: string
  latest_end?: string
  // Upper bound on the selected price as a Money object. The selected price must
  // match this currency and be a fixed amount at or below max_price.amount_minor.
  max_price?: Money
  allow_policy_fee?: boolean
  // Upper bound on any required policy fee or deposit. Same currency-match and
  // fixed-amount rules as max_price.
  max_extra_fee?: Money
}
```

Every booking mutation must include a `BookingMandate` and an `idempotency_key`. The mandate is unsigned JSON in v0.1.0, but the server still validates expiry, action, organization, service, provider, schedule, time, price, and policy-fee scope before mutation.

`expires_at` is an absolute instant and must carry `Z` or an explicit UTC offset. Naked wall-clock strings are rejected as `invalid_mandate`. `earliest_start` and `latest_end` are wall-clock strings in merchant-local time with no offset, compared against `Slot.starts_at_local` and `Slot.ends_at_local`, which follow the same convention. Offset-carrying values on those wall-clock fields are also rejected. The slot's absolute instants `starts_at` / `ends_at` are not part of the wall-clock window comparison.

`service_ids`, `provider_ids`, and `schedule_ids` should constrain the actual create-ready ids used for `booking.create`, not only display labels. Some platforms search availability from a host or location schedule while returning provider-specific schedule and service ids for the booking; the mandate must constrain the create-ready ids, not the search-time ones.

### Money

Every money-bearing value is a `Money` object, not a bare integer:

```ts
interface Money {
  amount_minor?: number
  currency: string
  type?: "fixed" | "insurance_dependent" | "quote_required" | "unknown"
  display?: string
}
```

`amount_minor` is an integer in the currency's [ISO 4217](https://www.iso.org/iso-4217-currency-codes.html) minor unit. The minor-unit exponent varies by currency: USD and EUR use 2 places, JPY uses 0, KWD and BHD use 3. It is not always cents. `amount_minor` is absent when `type` is `insurance_dependent`, `quote_required`, or `unknown`, where no fixed amount is known at read time.

`currency` is the ISO 4217 code and is required whenever a `Money` is present, so cross-currency comparisons fail closed instead of guessing.

`type` defaults to `fixed` when an amount is present. The non-fixed values mark a price that cannot be bounded by a mandate cap at booking time.

`display` is an optional locale-formatted string such as `$95.00`. It is a best-effort, non-canonical hint: agents SHOULD reformat `amount_minor` + `currency` in the end user's locale rather than parsing the `display` string, and implementations never parse it. Use `amount_minor` for arithmetic.

The money-bearing fields are `Service.price`, `ServiceOption.price`, `Slot.price`, `Policy.deposit`, `BookingMandate.max_price`, and `BookingMandate.max_extra_fee`.

OSBP does not convert currencies implicitly. If a selected service, slot, or policy is in a different currency from the mandate cap, the server fails closed with `currency_mismatch` and asks for a new user approval. A selected price without a fixed `amount_minor` fails closed with `requires_user_confirmation`.

### Time Discipline

A concrete slot or booking time is carried two ways at once: an absolute instant plus the merchant-local wall-clock. Time-bearing strings fall into two categories:

- Absolute instants with offsets, encoded as [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339): `Slot.starts_at`, `Slot.ends_at`, `Booking.starts_at`, `BookingMandate.expires_at`, and `AuditEvent.created_at`. The concrete slot/booking instants are the canonical cross-vertical form (FHIR, Google, Square, Cal.com, Zocdoc all key appointment times to instants); the adapter computes them from the merchant-local wall-clock plus the schedule's IANA timezone.
- Wall-clock strings without offsets, interpreted in a sibling IANA timezone (`Slot.schedule_timezone` / `Booking.schedule_timezone`): `Slot.starts_at_local`, `Slot.ends_at_local`, `Booking.starts_at_local`, `BookingMandate.earliest_start`, `BookingMandate.latest_end`, `BookingCreateInput.date`, `BookingCreateInput.time`, and `OperatingHours.open` / `close`. These are the values that round-trip into `booking.create`.

The split is deliberate. Wall-clock fields are intentionally not RFC 3339. Implementations must not add `Z` or a UTC offset to them, and must not strip the offset off the instant fields. The server rejects offset-carrying wall-clock values as `invalid_mandate`; the instant fields must carry an offset. OSBP carries the instant (the adapter computes it from merchant-local time plus the merchant's IANA timezone) but does not reconcile the user's own timezone with merchant-local time; that remains the agent's job.

Timezones use [IANA Time Zone Database](https://www.iana.org/time-zones) names. Customer phone numbers use [E.164](https://www.itu.int/rec/T-REC-E.164). Customer email addresses are [RFC 5322](https://www.rfc-editor.org/rfc/rfc5322) (or [RFC 6531](https://www.rfc-editor.org/rfc/rfc6531) for internationalized addresses) values; OSBP passes the value through and the platform enforces its own format. `OrganizationContext.country` uses [ISO 3166-1 alpha-2](https://www.iso.org/iso-3166-country-codes.html).

Durations are [ISO 8601](https://www.iso.org/iso-8601-date-and-time-format.html) duration strings such as `PT45M` or `PT24H`, not bare integers: `Service.duration`, `ServiceOption.duration`, `Policy.cancellation_window`, and `Policy.late_grace`. `OperatingHours.day` is an ISO 8601 weekday number, 1 = Monday through 7 = Sunday, not the JS `getDay` convention (0 = Sunday); the adapter converts the platform's value.

## Wire Format

### Naming

Protocol-level tool names are dotted:

```text
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

```text
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

Successful tool result:

```ts
{
  ok: true
  value: T
  audit_event_id?: string
}
```

Failed tool result:

```ts
{
  ok: false
  problem: Problem
  audit_event_id?: string
}
```

### Problem

```ts
interface Problem {
  code: string
  message: string
  retryable?: boolean
}
```

Stable `problem.code` values emitted by mandate validation and the reference adapter:

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
| `requires_consultation_handoff` | Service requires a consultation/quote workflow v0.1.0 cannot drive |
| `requires_user_confirmation` | Final confirmation, payment requirement, or amount is unknown. Fail closed before appointment creation |
| `requires_verification` | Platform requires customer verification before booking (retryable) |
| `verification_failed` | The submitted verification code was rejected (wrong or expired); retry the send and verify step |
| `slot_taken` | The selected slot is no longer available (retryable) |
| `idempotency_conflict` | Same `idempotency_key` reused with a different payload |
| `booking_not_found` | No appointment matches the status query |
| `booking_status_requires_verification` | Appointment history is gated behind a verification step that v0.1.0 read tools cannot complete. Rely on the `booking.create` receipt or hand off |
| `rate_limited` | Upstream returned HTTP 429. Back off and retry (retryable) |
| `verification_not_supported` | Platform has no customer-verification step; `verification.send` and `verification.verify` do not apply |
| `internal_adapter_error` | An adapter threw unexpectedly; the host caught it and recorded an audited Problem rather than leaking the throw |

Adapters may emit additional adapter-specific codes, for example `missing_config`. The codes above are the protocol-meaningful set.

## Tool Inputs

```ts
interface ServiceDescribeInput {
  service_id?: string
}

interface AvailabilityFindInput {
  service_id?: string
  schedule_id?: string
  // Wall-clock date in merchant-local time, "YYYY-MM-DD".
  date: string
  provider_id?: string
}

interface PolicyExplainInput {
  service_id?: string
}

interface VerificationSendInput {
  customer?: Customer
  purpose?: string
}

interface VerificationVerifyInput {
  customer?: Customer
  purpose?: string
  code: string
}

interface BookingCreateInput {
  mandate: BookingMandate
  idempotency_key: string
  service_id: string
  schedule_id: string
  provider_id: string
  // Wall-clock date in merchant-local time, "YYYY-MM-DD".
  date: string
  // Wall-clock 24-hour time in merchant-local time, "HH:MM" or "HH:MM:SS".
  time: string
  customer?: Customer
  approval?: BookingApproval
  verification_code?: string
}

interface BookingApproval {
  confirmed: true
  token: string
}

interface BookingStatusInput {
  booking_id?: string
  customer?: Customer
}
```

Read paths can default. `service.describe`, `availability.find`, and `policy.explain` may omit ids that the adapter can substitute from configured proof-of-concept defaults. Mutations do not default: `booking.create` keeps strict required service, schedule, provider, mandate, and idempotency fields.

Final confirmation is an adapter-side gate shared by every OSBP adapter through `requireApproval` in `@osbp/core`. A first valid `booking.create` call with no `approval` returns `requires_user_confirmation` before any appointment create call. The agent must show the exact summary from the problem message to the user, get final confirmation, then retry `booking.create` with the same payload, same `idempotency_key`, `approval.confirmed: true`, and the adapter-issued `approval.token`. `approval` is excluded from the local idempotency payload hash, as is `verification_code`, so an approved retry and a verification retry remain the same logical booking attempt. The token still flows through the agent, so it is a brake, not proof of a real user click; production confirmation belongs in the host/server layer.

For booking verification, call `booking.create` first. If it returns `requires_verification`, call `verification.send`, ask the user for the code, then retry `booking.create` with `verification_code`. Do not call `verification.verify` before booking create for the booking flow.

## VerificationChallenge

```ts
interface VerificationChallenge {
  sent?: boolean
  verified?: boolean
  method?: "sms" | "email" | "unknown"
  purpose: string
}
```

## AuditEvent

```ts
interface PlatformIdentity {
  // Stable platform slug, e.g. "osbp-reference-backend".
  vendor: string
  // The exact native API pin the adapter sends or encodes (request header
  // value, media-type parameter, or base-URL path segment).
  api_version: string
}

interface UpstreamMeta {
  // Upstream request as "METHOD /path". Query strings are omitted and
  // contact-bearing path segments are redacted.
  call: string
  status: number
  // Server header, verbatim. An infrastructure fingerprint (often the CDN or
  // edge-proxy build), not an application or API version.
  server?: string
  // First response header whose name contains "request-id"; the per-call
  // correlation handle for support escalation with the platform.
  request_id?: string
  // Response-side API version echo when the platform sends one.
  api_version?: string
  // Deprecation header (RFC 9745), verbatim.
  deprecation?: string
  // Sunset header (RFC 8594), verbatim HTTP-date.
  sunset?: string
  // RateLimit, RateLimit-Policy, and X-RateLimit-* headers, keyed lowercase.
  ratelimit?: Record<string, string>
}

interface AuditEvent {
  id: string
  mandate_id?: string
  tool_name: OsbpToolName
  // RFC 3339 instant with Z or an explicit UTC offset.
  created_at: string
  source?: string
  // Static identity of the adapter that served this tool call.
  platform?: PlatformIdentity
  // Response metadata from the most recent upstream call observed during
  // this tool call. Absent when the tool answered locally.
  upstream?: UpstreamMeta
  input?: unknown
  result?: unknown
  input_hash?: string
  result_hash?: string
}
```

`platform` and `upstream` are operator-observability fields for upstream drift provenance, never agent-facing booking output. They carry no customer data by construction: `upstream.call` is method plus redacted path, and the remaining fields are response headers.

The local v0.1.0 MCP server appends redacted JSONL audit events to `.osbp/audit/events.jsonl` by default. Set `OSBP_AUDIT_LOG_PATH` to override the path.

Audit events must redact customer contact details and verification codes. Checked-in traces should use audit aliases rather than raw local audit records. `input_hash` and `result_hash` are hex SHA-256 digests of the redacted snapshots.

## Adapter Interface

```ts
type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; problem: Problem }

interface BookingAdapter {
  // Static platform identity and most-recent upstream response metadata,
  // recorded into audit events. See the spec's Platform Metadata and
  // Versioning section and the AuditEvent shapes above.
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
