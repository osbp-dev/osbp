export const OSBP_VERSION = "0.1.0";
export { buildLabel } from "./build-label.js";

export const OSBP_TOOL_NAMES = [
  "service.describe",
  "availability.find",
  "policy.explain",
  "verification.send",
  "verification.verify",
  "booking.create",
  "booking.status",
  "handoff.request"
] as const;

export type OsbpToolName = (typeof OSBP_TOOL_NAMES)[number];

export interface Problem {
  code: string;
  message: string;
  retryable?: boolean;
}

export type MoneyType = "fixed" | "insurance_dependent" | "quote_required" | "unknown";

export interface Money {
  // Integer amount in the currency's ISO 4217 minor unit. The exponent VARIES
  // by currency: USD and EUR use 2 places, JPY uses 0, KWD and BHD use 3. It is
  // NOT always cents. Absent for type "insurance_dependent", "quote_required",
  // or "unknown", where no fixed amount is known at read time.
  amount_minor?: number;
  // ISO 4217 currency code (e.g., "USD"). Required whenever a Money is present,
  // so cross-currency comparisons can fail closed instead of guessing.
  currency: string;
  // Defaults to "fixed" when an amount is present. The non-fixed values mark a
  // price that cannot be bounded by a mandate cap at booking time.
  type?: MoneyType;
  // Optional locale-formatted string (e.g., "$95.00"). Non-canonical: present
  // for display only. Never parse it; use amount_minor for arithmetic.
  display?: string;
}

export interface BookingMandate {
  id: string;
  // UTC ISO 8601 instant (must carry `Z` or an explicit offset). Compared
  // via Date.parse against the current wall-clock instant — a naked
  // wall-clock string here would be parsed in the host's local timezone
  // and could expire hours early or late.
  expires_at: string;
  allowed_actions: OsbpToolName[];
  organization_id: string;
  // service_ids / provider_ids / schedule_ids are optional because their
  // presence encodes mandate strictness. An omitted array leaves that
  // dimension unconstrained (a looser mandate); listing ids restricts the
  // agent to exactly those services, providers, or schedules (a stricter
  // mandate). schedule_ids is the most specific: pinning a schedule
  // transitively constrains the provider and location it belongs to, so
  // v0.1.0 needs no separate mandate field for location-level identity.
  service_ids?: string[];
  provider_ids?: string[];
  schedule_ids?: string[];
  // Wall-clock ISO strings in merchant-local time, no offset (e.g.,
  // "2026-05-02T09:00:00"). Compared lexicographically against
  // Slot.starts_at_local, which is also wall-clock, and both sides must follow
  // the same convention or the validator silently misjudges scope. They are
  // NOT compared against the slot's absolute instant Slot.starts_at.
  earliest_start?: string;
  latest_end?: string;
  // Upper bound on the selected service or slot price. When present with an
  // amount_minor, the validator fails closed unless the selected price is a
  // fixed amount in the same currency at or below this cap.
  max_price?: Money;
  allow_policy_fee?: boolean;
  // Upper bound on any required policy fee or deposit. Same currency-match and
  // fixed-amount rules as max_price.
  max_extra_fee?: Money;
}

export interface Service {
  id: string;
  name: string;
  // ISO 8601 duration string for the service length, e.g. "PT45M" for 45
  // minutes. Named against ISO 8601 so a code generator does not assume a bare
  // integer count of minutes. Absent when the platform reports no duration.
  duration?: string;
  // Service price as a Money object: integer amount_minor in the currency's
  // ISO 4217 minor unit (the exponent varies by currency, so it is not always
  // cents), a required currency code, and an optional locale-formatted display
  // string. Use amount_minor for arithmetic and mandate scope checks; show
  // Money.display for any user-visible price.
  price?: Money;
  // True when booking this service routes to a merchant-side approval queue
  // instead of creating an appointment. Agents must surface this to the user
  // before attempting booking.create — the call may "succeed" without producing
  // a real appointment.
  requires_consultation?: boolean;
  // Service variants/upsells (e.g., add-ons or sub-options).
  options?: ServiceOption[];
}

export interface ServiceOption {
  id: string;
  name?: string;
  // Option price as a Money object. amount_minor is in the currency's ISO 4217
  // minor unit (exponent varies by currency); show Money.display to the user.
  price?: Money;
  // ISO 8601 duration string, e.g. "PT15M". Same convention as Service.duration.
  duration?: string;
}

export interface LocationSchedule {
  id: string;
  name?: string;
  slug?: string;
  address?: string;
  // IANA tz name (e.g., "America/Los_Angeles") for this location. Required
  // to interpret the wall-clock strings in `hours[].open` / `.close`.
  timezone?: string;
  latitude?: number;
  longitude?: number;
  hours?: OperatingHours[];
}

// One open period for a single weekday, in `open`..`close`. Presence means
// open: a weekday with no entry is closed, so there is no redundant flag (the
// same convention Square and Google Business Profile use). A day may appear
// more than once for split shifts.
export interface OperatingHours {
  // Day of week as an ISO 8601 weekday number: 1 = Monday through 7 = Sunday.
  // Named against ISO 8601 so a code generator does not assume the JS getDay
  // convention (0 = Sunday); the adapter converts the platform's value.
  day: number;
  // 24-hour HH:MM strings ("10:00", "18:00") in the location's local
  // wall-clock time. The IANA tz name lives on the parent (Slot.schedule_timezone
  // or LocationSchedule.timezone) — these strings have no offset of their own.
  open: string;
  close: string;
}

export interface Slot {
  id: string;
  // The organization this slot belongs to. Surfaced on every Slot so an agent
  // building a booking.create mandate from availability results doesn't
  // have to make a separate descriptive call to discover the organization id.
  organization_id?: string;
  schedule_id: string;
  schedule_name?: string;
  schedule_address?: string;
  schedule_latitude?: number;
  schedule_longitude?: number;
  schedule_hours?: OperatingHours[];
  // IANA tz name (e.g., "America/Los_Angeles") for this location. Authoritative
  // for interpreting starts_at_local and schedule_hours, both of which are
  // emitted as wall-clock strings without offsets to round-trip cleanly through
  // booking.create, and the tz the adapter uses to compute the absolute instant
  // starts_at. Sourced from the location record when the upstream platform populates it,
  // otherwise falls back to the organization's configured timezone. Agents should
  // prefer this over schedule_address for any wall-clock reasoning. The demo
  // organization has a NYC address but is configured for America/Los_Angeles, so
  // address-derived guesses are off by three hours.
  schedule_timezone?: string;
  provider_id?: string;
  provider_name?: string;
  // URL to a display image for the provider (a photo, avatar, or logo, depending on
  // the platform); not necessarily a photograph, and a likeness of a named person,
  // so treat it as mild personal data.
  provider_image_url?: string;
  // True when the provider has a portfolio of work. Surfaced as an
  // affordance signal so an agent can offer "want to see Amy's work?"
  // without guessing, but treat it as a hint, not a guarantee that any
  // portfolio link or content is currently exposed by OSBP.
  provider_has_portfolio?: boolean;
  service_id: string;
  // Absolute RFC 3339 instant (carries `Z` or an explicit offset) for this
  // slot's start. This is the canonical, cross-vertical-correct form: the
  // adapter computes it from starts_at_local plus schedule_timezone via the
  // IANA tz, so a moment is unambiguous independent of any organization location.
  // Absent only when schedule_timezone is unknown (the adapter never guesses
  // an instant without a tz). Compared with Date.parse against other instants,
  // never against the wall-clock fields.
  starts_at?: string;
  // Absolute RFC 3339 instant for this slot's end, same convention as
  // starts_at. Present only when ends_at_local and schedule_timezone are both
  // known.
  ends_at?: string;
  // Wall-clock ISO string in schedule_timezone, no offset (e.g.,
  // "2026-05-02T12:00:00"). Round-trips into BookingCreateInput.date/time
  // unchanged. Compare against BookingMandate.earliest_start / latest_end,
  // which use the same wall-clock convention. This is the value the merchant
  // platform stores and accepts; the absolute instant above is derived from it.
  starts_at_local: string;
  // Wall-clock ISO string in schedule_timezone, same convention as
  // starts_at_local.
  ends_at_local?: string;
  // Slot price as a Money object: integer amount_minor in the currency's ISO
  // 4217 minor unit (exponent varies by currency, so not always cents), a
  // required currency code, and an optional locale-formatted display string.
  // Use amount_minor for arithmetic and mandate scope checks; show
  // Money.display for any user-visible price.
  price?: Money;
  organization_name?: string;
}

export interface Policy {
  service_id?: string;
  // Cancellation enforcement (organization-level).
  cancellation_enabled?: boolean;
  // ISO 8601 duration string for the cancellation window, e.g. "PT24H". Named
  // against ISO 8601 so a code generator does not assume a bare number of hours.
  cancellation_window?: string;
  cancellation_note?: string;
  // ISO 8601 duration string for the post-start grace period, e.g. "PT15M".
  // Same convention as cancellation_window.
  late_grace?: string;
  // Fee charged for a late cancellation, as a Money object, when the platform
  // exposes it. Surfaced so an agent can show the user the conditional
  // liability of a booking: even a free service can carry a cancellation fee.
  // OSBP v0.1.0 does NOT yet enforce or cap this through the mandate; that is
  // roadmap, tied to payment composition.
  cancellation_fee?: Money;
  // Fee charged for a no-show, as a Money object, when the platform exposes it.
  // Surfaced so an agent can show the user the conditional liability of a
  // booking: even a free service can carry a no-show fee. OSBP v0.1.0 does NOT
  // yet enforce or cap this through the mandate; that is roadmap, tied to
  // payment composition.
  no_show_fee?: Money;
  // Payment expectations (service-level).
  payment_requirement?: "none" | "deposit" | "full_prepay" | "unknown";
  // Required deposit as a Money object. amount_minor is in the currency's ISO
  // 4217 minor unit (exponent varies by currency). Checked against
  // BookingMandate.max_extra_fee when payment_requirement is "deposit".
  deposit?: Money;
  // Verification method the merchant uses for new customers. Determines whether
  // booking.create may return requires_verification and which channel
  // verification.send uses. "none" means the platform has no customer
  // verification step at all: such adapters return verification_not_supported
  // from verification.send / verification.verify and never emit
  // requires_verification. "unknown" means the method could not be determined.
  verification_method?: "sms" | "email" | "none" | "unknown";
  // Merchant identity / contact / context the agent should be able to present
  // to the user without having to call a separate "describe organization" tool.
  organization?: OrganizationContext;
}

export interface OrganizationContext {
  // The organization's canonical id. Required by the mandate's organization_id field on
  // booking.create, so it must be surfaced through a read tool — agents
  // construct mandates from policy.explain responses and would otherwise
  // have no way to learn the id without inspecting local adapter config.
  id?: string;
  name?: string;
  slug?: string;
  domain?: string;
  phone?: string;
  support_email?: string;
  instagram_handle?: string;
  timezone?: string;
  currency?: string;
  // ISO 3166-1 alpha-2 (e.g., "US"). Disambiguates regional norms when
  // currency alone is ambiguous (USD is used in multiple jurisdictions).
  country?: string;
  // Number of locations the organization operates. Useful so the agent doesn't
  // assume single-shop when the merchant has multiple branches.
  total_locations?: number;
}

export interface Customer {
  id?: string;
  phone?: string;
  email?: string;
  display_name?: string;
}

export interface VerificationSendInput {
  customer?: Customer;
  purpose?: string;
}

export interface VerificationVerifyInput {
  customer?: Customer;
  purpose?: string;
  code: string;
}

export interface VerificationChallenge {
  sent?: boolean;
  verified?: boolean;
  method?: "sms" | "email" | "unknown";
  purpose: string;
}

export interface BookingCreateInput {
  mandate: BookingMandate;
  idempotency_key: string;
  service_id: string;
  schedule_id: string;
  provider_id: string;
  // Wall-clock date in merchant-local time ("YYYY-MM-DD"). Pulled from
  // Slot.starts_at_local.slice(0,10); paired with `time` on the wire.
  date: string;
  // Wall-clock 24-hour time in merchant-local time ("HH:MM" or "HH:MM:SS").
  // Pulled from Slot.starts_at_local.slice(11,16); the upstream platform stores both as wall-clock.
  time: string;
  customer?: Customer;
  approval?: BookingApproval;
  verification_code?: string;
}

export interface BookingApproval {
  confirmed: true;
  token: string;
}

export interface BookingStatusInput {
  booking_id?: string;
  customer?: Customer;
}

export type BookingStatus =
  | "booked"
  | "cancelled"
  | "completed"
  | "no_show"
  | "pending"
  | "unknown";

export interface Booking {
  id: string;
  // Normalized lifecycle status from a closed enum. The adapter maps the
  // platform's native status string onto these values; an unrecognized or
  // absent platform status becomes "unknown".
  status?: BookingStatus;
  service_id?: string;
  schedule_id?: string;
  provider_id?: string;
  // Absolute RFC 3339 instant (carries `Z` or an explicit offset) for the
  // booking start. Derived by the adapter from starts_at_local plus
  // schedule_timezone via the IANA tz. Absent when schedule_timezone is
  // unknown. Compared with Date.parse against other instants, never against
  // the wall-clock field below.
  starts_at?: string;
  // Wall-clock ISO string in merchant-local time (no offset). Built from
  // BookingCreateInput.date + .time on create; from the upstream booking-history
  // record's date/time fields on readback. Treat the lack of offset as
  // intentional — the upstream platform stores wall-clock and round-tripping it is
  // lossless. The absolute instant above is derived from this plus
  // schedule_timezone.
  starts_at_local?: string;
  // IANA tz name (e.g., "America/Los_Angeles") that interprets
  // starts_at_local and was used to compute starts_at. Carried so a reader can
  // reconstruct either representation. Absent when the source schedule's tz is
  // unknown.
  schedule_timezone?: string;
  customer_id?: string;
}

export interface ServiceDescribeInput {
  service_id?: string;
}

export interface AvailabilityFindInput {
  // service_id and schedule_id are optional at the protocol level; adapters may
  // substitute configured defaults (e.g. the adapter's first configured service
  // or schedule id) so an agent can ask "what's open tomorrow" without
  // having to discover ids first.
  service_id?: string;
  schedule_id?: string;
  // Wall-clock date in merchant-local time ("YYYY-MM-DD"). Sent as-is to
  // the upstream availability endpoint; the returned slot.starts_at_local strings
  // are interpreted in the same merchant-local timezone (Slot.schedule_timezone),
  // and slot.starts_at carries the derived absolute instant.
  date: string;
  provider_id?: string;
}

export interface PolicyExplainInput {
  service_id?: string;
}

export interface Receipt {
  id: string;
  text: string;
  booking_id?: string;
}

export interface PlatformIdentity {
  // Stable platform slug identifying the booking vendor.
  vendor: string;
  // The exact native API pin the adapter sends or encodes: a version request
  // header value, a media-type version parameter, or the version segment of
  // the base URL. Not a vanity label.
  api_version: string;
}

export interface UpstreamMeta {
  // Upstream request as "METHOD /path". Path only: query strings are omitted
  // and contact-bearing path segments are redacted, because this object flows
  // into audit events, which must never carry customer contact details.
  call: string;
  status: number;
  // Server response header, verbatim. An infrastructure fingerprint, often
  // the CDN or edge-proxy build rather than the platform application. Must
  // not be presented as an application or API version.
  server?: string;
  // First response header whose name contains "request-id". The per-call
  // correlation handle for support escalation with the platform.
  request_id?: string;
  // Response-side API version echo when the platform sends one. The adapter
  // selects which response header carries it.
  api_version?: string;
  // Deprecation header (RFC 9745), verbatim.
  deprecation?: string;
  // Sunset header (RFC 8594), verbatim HTTP-date.
  sunset?: string;
  // RateLimit, RateLimit-Policy, and X-RateLimit-* headers, keyed lowercase.
  ratelimit?: Record<string, string>;
}

export interface AuditEvent {
  id: string;
  mandate_id?: string;
  tool_name: OsbpToolName;
  // UTC ISO 8601 instant (must carry `Z` or an explicit offset). Audit
  // events span agent hosts, organization timezones, and downstream readers,
  // so this is always an absolute moment — not a wall-clock string.
  created_at: string;
  source?: string;
  // Static identity of the adapter that served this tool call.
  platform?: PlatformIdentity;
  // Response metadata from the most recent upstream call observed during this
  // tool call. Absent when the tool answered locally (idempotency-cache hit,
  // handoff.request).
  upstream?: UpstreamMeta;
  input?: unknown;
  result?: unknown;
  input_hash?: string;
  result_hash?: string;
}

export type AdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; problem: Problem };

export interface BookingAdapter {
  // Static identity of the booking platform this adapter speaks to, recorded
  // into audit events for drift provenance.
  readonly platform?: PlatformIdentity;
  // Response metadata from the adapter's most recent upstream call.
  readonly upstreamMeta?: UpstreamMeta;
  describeService(input: ServiceDescribeInput): Promise<AdapterResult<Service>>;
  findAvailability(input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>>;
  explainPolicy(input: PolicyExplainInput): Promise<AdapterResult<Policy>>;
  sendVerification(input: VerificationSendInput): Promise<AdapterResult<VerificationChallenge>>;
  verifyCode(input: VerificationVerifyInput): Promise<AdapterResult<VerificationChallenge>>;
  // MUST validate the mandate (validateMandate) against the resolved service,
  // slot, and policy before issuing the platform mutation. The reference host
  // does not validate on the adapter's behalf, so an adapter that skips this
  // ships no enforcement at all. See the spec Adapter Contract.
  createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>>;
  getBooking(input: BookingStatusInput): Promise<AdapterResult<Booking>>;
}

export * from "./mandate.js";
export * from "./approval.js";
