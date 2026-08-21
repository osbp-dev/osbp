import type {
  AdapterResult,
  AvailabilityFindInput,
  Booking,
  BookingAdapter,
  BookingCreateInput,
  BookingStatusInput,
  Customer,
  Money,
  PendingApproval,
  PlatformIdentity,
  Policy,
  PolicyExplainInput,
  Receipt,
  Service,
  ServiceDescribeInput,
  Slot,
  UpstreamMeta,
  VerificationChallenge,
  VerificationSendInput,
  VerificationVerifyInput
} from "@osbp/core";
import { OSBP_VERSION, requireApproval, validateMandate } from "@osbp/core";
import { createHash, randomUUID } from "node:crypto";

export interface StarterBookingAdapterConfig {
  // Required operator-supplied API origin. Real adapters must not default this
  // to a shared tenant or live platform account.
  apiBaseUrl: string;
  organizationId: string;
  // Positive milliseconds for each outbound request. Configure deliberately in
  // copied adapters instead of relying on Node's process-level defaults.
  httpTimeoutMs?: number;
  credentials?: StarterBookingAdapterCredentials;
  // Copy this to the platform-specific version header, media type, or path
  // segment when the platform has a native pin. Leave absent only when the
  // platform has no supportable request-side version mechanism.
  nativeApiVersion?: string;
  // Customer fallback is a migration/testing convenience, not identity proof.
  // Copied adapters must keep it disabled unless the operator explicitly opts in.
  enableConfiguredCustomerFallback?: boolean;
  configuredCustomerFallback?: StarterCustomer;
  // Undefined means omit platform notification flags by default. Replace this
  // simple marker with platform-specific notification controls only when the
  // operator has approved the behavior.
  notificationBehavior?: StarterNotificationBehavior;
}

export interface StarterBookingAdapterCredentials {
  apiKey?: string;
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
}

export type StarterNotificationBehavior = "omit" | "operator_configured";

interface IdempotencyEntry {
  payloadHash: string;
  result: AdapterResult<Receipt>;
  booking?: Booking;
}

interface CreateValidationContext {
  service: Service;
  slot: Slot;
  policy: Policy;
}

interface PlatformCreateResult {
  receipt: Receipt;
  booking?: Booking;
}

interface InFlightBooking {
  payloadHash: string;
  promise: Promise<AdapterResult<Receipt>>;
}

type JsonRecord = Record<string, unknown>;

export class StarterBookingAdapter implements BookingAdapter {
  readonly platform: PlatformIdentity = { vendor: "replace-me", api_version: "replace-me" };
  private lastUpstreamMeta: UpstreamMeta | undefined;
  private readonly idempotencyCache = new Map<string, IdempotencyEntry>();
  private readonly inFlightBookings = new Map<string, InFlightBooking>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  get upstreamMeta(): UpstreamMeta | undefined {
    return this.lastUpstreamMeta;
  }

  constructor(readonly config: StarterBookingAdapterConfig) {}

  async describeService(_input: ServiceDescribeInput): Promise<AdapterResult<Service>> {
    /*
     * TODO service.describe:
     * - Call the platform endpoint that returns one service by id, or the
     *   service list endpoint and select the requested id.
     * - Map duration to an ISO 8601 duration string such as "PT45M".
     * - Map price to Money.amount_minor plus ISO 4217 currency. Do not divide
     *   by 100 unless the platform documents that exact currency exponent.
     * - Surface requires_consultation when booking routes to approval or quote
     *   workflows.
     * Worked example: packages/reference-backend/src/index.ts
     * SyntheticBookingAdapter.describeService.
     */
    return notImplemented("service.describe has not been mapped to the target platform API");
  }

  async findAvailability(_input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>> {
    /*
     * TODO availability.find:
     * - Call the platform availability endpoint for service,
     *   schedule, provider, and local date.
     * - Preserve platform ids, including organization_id, schedule_id,
     *   provider_id, service_id, and slot id.
     * - Emit starts_at as an offset-bearing RFC 3339 instant when timezone data
     *   is available, and starts_at_local as merchant-local wall-clock time
     *   without an offset.
     * - Denormalize schedule, provider, location, and organization names on
     *   each Slot so an agent can present results without extra round-trips.
     * Worked example: packages/reference-backend/src/index.ts
     * SyntheticBookingAdapter.findAvailability.
     */
    return notImplemented("availability.find has not been mapped to the target platform API");
  }

  async explainPolicy(_input: PolicyExplainInput): Promise<AdapterResult<Policy>> {
    /*
     * TODO policy.explain:
     * - Read cancellation, late, payment, deposit, and verification policy from
     *   the platform's organization, location, and service fields.
     * - Return payment_requirement as none, deposit, full_prepay, or unknown.
     * - Include organization.id so agents can build BookingMandate.organization_id
     *   from a read path rather than a local env file.
     * Worked example: packages/reference-backend/src/index.ts
     * SyntheticBookingAdapter.explainPolicy.
     */
    return notImplemented("policy.explain has not been mapped to the target platform API");
  }

  async sendVerification(_input: VerificationSendInput): Promise<AdapterResult<VerificationChallenge>> {
    /*
     * TODO verification.send:
     * - Call the platform's customer verification send endpoint.
     * - Return sent: true with method "sms" or "email" only when the platform
     *   accepted the send request.
     * - Return a clear unsupported-verification Problem when the platform has no verification
     *   concept and policy.explain reports verification_method: "none".
     * Worked example: packages/reference-backend/src/index.ts
     * SyntheticBookingAdapter.sendVerification.
     */
    return notImplemented("verification.send has not been mapped to the target platform API");
  }

  async verifyCode(_input: VerificationVerifyInput): Promise<AdapterResult<VerificationChallenge>> {
    /*
     * TODO verification.verify:
     * - Call the platform's verification check endpoint with the user supplied
     *   code and the same customer or purpose used by verification.send.
     * - Return verified: true only when the platform confirms the code.
     * - Return verification_failed as an AdapterResult Problem for bad codes.
     * Worked example: packages/reference-backend/src/index.ts
     * SyntheticBookingAdapter.verifyCode.
     */
    return notImplemented("verification.verify has not been mapped to the target platform API");
  }

  async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    /*
     * TODO booking.create:
     * - Resolve the service, selected slot, and policy using the platform
     *   mapping helpers before any mutation.
     * - Fail closed when required booking truth is missing. Do not invent
     *   service, provider, schedule, price, customer identity, policy,
     *   verification, or payment facts to satisfy a create endpoint.
     * - Keep validateMandate exactly before the platform create call. The host
     *   does not enforce it for the adapter.
     * - Use input.idempotency_key only for the local cache or a platform-native
     *   idempotency primitive that is empirically confirmed. Do not pipe it into
     *   unrelated id-like fields.
     * - Use config.nativeApiVersion only as a copy-paste marker for the
     *   platform's real version pin. Put the actual header, media type, or path
     *   version in explicit adapter code instead of hiding it in a generic
     *   client abstraction.
     * - Use config.enableConfiguredCustomerFallback only when the operator has
     *   deliberately configured a fallback customer. Treat that fallback as a
     *   booking convenience, not identity proof; production identity should move
     *   to the host/auth boundary.
     * - Omit notification flags by default. If the platform sends emails, SMS,
     *   or merchant/customer notifications, expose an operator-approved config
     *   choice instead of hardcoding platform notification behavior.
     * - Require final approval after validation and before the platform create
     *   call. The approval token is deliberately bound to the exact payload
     *   hash, so a retry cannot change the booking and reuse the same token.
     * - Map success into a human-readable Receipt with booking_id, then store
     *   the receipt in the local idempotency cache.
     * Worked example: packages/reference-backend/src/index.ts
     * SyntheticBookingAdapter.createBooking.
     */
    // Approval and verification are retry artifacts, not new booking intent:
    // the first call (no approval), the approved retry, and the verification
    // retry must all resolve to the same pending approval entry and the same
    // idempotency record. All material booking fields, including the
    // idempotency_key itself, remain in the hash.
    const payloadHash = stableHash(redactTransientCreateFields(input));
    const cached = this.idempotencyCache.get(input.idempotency_key);
    if (cached) {
      return cached.payloadHash === payloadHash ? cached.result : idempotencyConflict();
    }

    const context = await this.resolveCreateValidationContext(input);
    if (!context.ok) {
      return context;
    }

    const validation = validateMandate({
      mandate: input.mandate,
      action: "booking.create",
      organization_id: this.config.organizationId,
      service: context.value.service,
      slot: context.value.slot,
      policy: context.value.policy
    });
    if (!validation.ok) {
      return { ok: false, problem: validation.problem };
    }

    const approvalGate = requireApproval({
      approval: input.approval,
      payloadHash,
      summary: bookingApprovalSummary(input, context.value.service, context.value.slot, context.value.policy),
      store: this.pendingApprovals,
      now: Date.now(),
      newToken: randomUUID
    });
    if (!approvalGate.ok) {
      return approvalGate;
    }

    const inFlight = this.inFlightBookings.get(input.idempotency_key);
    if (inFlight) {
      return inFlight.payloadHash === payloadHash ? inFlight.promise : idempotencyConflict();
    }

    const attempt = this.performApprovedCreate(input, payloadHash, context.value);
    this.inFlightBookings.set(input.idempotency_key, { payloadHash, promise: attempt });
    return attempt;
  }

  async getBooking(input: BookingStatusInput): Promise<AdapterResult<Booking>> {
    /*
     * TODO booking.status:
     * - Prefer an authenticated direct booking read by id when the platform has
     *   one.
     * - Fall back to a local idempotency snapshot only for OSBP-created
     *   bookings when the platform cannot read by id.
     * - If the platform gates history behind a verification step and this method cannot
     *   complete that challenge, fail closed instead of fabricating status.
     * Worked example: packages/reference-backend/src/index.ts
     * SyntheticBookingAdapter.getBooking.
     */
    const cachedBooking = [...this.idempotencyCache.values()]
      .map((entry) => entry.booking)
      .find((booking): booking is Booking => booking?.id === input.booking_id);
    if (cachedBooking) {
      return ok(cachedBooking);
    }

    return notImplemented("booking.status has not been mapped to the target platform API");
  }

  protected async createBookingOnPlatform(
    _input: BookingCreateInput,
    _context: CreateValidationContext
  ): Promise<AdapterResult<PlatformCreateResult>> {
    return notImplemented("booking.create has not been mapped to the target platform API");
  }

  protected async resolveCreateValidationContext(
    input: BookingCreateInput
  ): Promise<AdapterResult<CreateValidationContext>> {
    const service = await this.describeService({ service_id: input.service_id });
    if (!service.ok) {
      return service;
    }

    const policy = await this.explainPolicy({ service_id: input.service_id });
    if (!policy.ok) {
      return policy;
    }

    const availability = await this.findAvailability({
      service_id: input.service_id,
      schedule_id: input.schedule_id,
      provider_id: input.provider_id,
      date: input.date
    });
    if (!availability.ok) {
      return availability;
    }

    const providerScope = providerScopeProblem(input);
    if (providerScope) {
      return providerScope;
    }

    const startsAtLocal = `${input.date}T${input.time.length === 5 ? `${input.time}:00` : input.time}`;
    const slot = availability.value.find((candidate) =>
      candidate.service_id === input.service_id &&
      candidate.schedule_id === input.schedule_id &&
      candidate.provider_id === input.provider_id &&
      candidate.starts_at_local === startsAtLocal
    );
    if (!slot) {
      return {
        ok: false,
        problem: {
          code: "slot_taken",
          message: "Selected slot was not present in the target platform availability response",
          retryable: true
        }
      };
    }

    return {
      ok: true,
      value: {
        service: service.value,
        policy: policy.value,
        slot
      }
    };
  }

  protected async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = new URL(withTrailingSlash(this.config.apiBaseUrl));
    const url = new URL(path, baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new Error(`request path resolved outside configured API origin: ${redactPathSegments(url.pathname)}`);
    }
    const timeout = requestTimeout(this.config.httpTimeoutMs, init.signal);
    try {
      const response = await fetch(url, {
        ...init,
        signal: timeout.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": `OSBP/${OSBP_VERSION} adapter-starter/${OSBP_VERSION} node/${process.versions.node.split(".")[0]}`,
          "x-osbp-source": `adapter-starter/${OSBP_VERSION}`,
          ...authHeaders(this.config.credentials),
          ...init.headers
        }
      });
      this.lastUpstreamMeta = captureUpstreamMeta(
        `${(init.method ?? "GET").toUpperCase()} ${redactPathSegments(url.pathname)}`,
        response
      );

      if (!response.ok) {
        throw new StarterAdapterHttpError(
          response.status,
          response.statusText,
          redactPathSegments(url.pathname),
          await response.text()
        );
      }

      return (await response.json()) as T;
    } finally {
      timeout.cleanup();
    }
  }

  private async performApprovedCreate(
    input: BookingCreateInput,
    payloadHash: string,
    context: CreateValidationContext
  ): Promise<AdapterResult<Receipt>> {
    try {
      const result = await this.createBookingOnPlatform(input, context);
      if (!result.ok) {
        return result;
      }
      this.rememberIdempotentResult(
        input.idempotency_key,
        payloadHash,
        ok(result.value.receipt),
        result.value.booking
      );
      this.pendingApprovals.delete(payloadHash);
      return ok(result.value.receipt);
    } catch (error) {
      return problemFromCreateException(error);
    } finally {
      this.inFlightBookings.delete(input.idempotency_key);
    }
  }

  protected rememberIdempotentResult(
    key: string,
    payloadHash: string,
    result: AdapterResult<Receipt>,
    booking?: Booking
  ): void {
    this.idempotencyCache.set(key, {
      payloadHash,
      result,
      booking
    });
  }
}

export class StarterAdapterHttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    readonly path: string,
    readonly body: string
  ) {
    super(`${status} ${statusText} from ${path}`);
  }
}

export function ok<T>(value: T): AdapterResult<T> {
  return { ok: true, value };
}

export function notImplemented<T>(message: string): AdapterResult<T> {
  return {
    ok: false,
    problem: {
      code: "adapter_not_implemented",
      message,
      retryable: false
    }
  };
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => (value as JsonRecord)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as JsonRecord)[key])}`)
    .join(",")}}`;
}

function redactTransientCreateFields(input: BookingCreateInput): BookingCreateInput {
  return {
    ...input,
    verification_code: undefined,
    approval: undefined
  };
}

function bookingApprovalSummary(
  input: BookingCreateInput,
  service: Service,
  slot: Slot,
  policy: Policy
): string {
  const price = slot.price ?? service.price;
  const priceText = formatMoney(price);
  const paymentText = policy.payment_requirement === "none"
    ? "No upfront payment or deposit is required to book."
    : `Payment requirement: ${policy.payment_requirement ?? "unknown"}.`;
  const cancellationFee = formatOptionalMoney(policy.cancellation_fee);
  const noShowFee = formatOptionalMoney(policy.no_show_fee);
  const policyParts = [
    paymentText,
    cancellationFee ? `Cancellation fee: ${cancellationFee}.` : undefined,
    noShowFee ? `No-show fee: ${noShowFee}.` : undefined
  ].filter((part): part is string => Boolean(part));
  return `Book ${service.name} on ${input.date} at ${input.time} merchant-local time for ${priceText}. ${policyParts.join(" ")}`;
}

function formatMoney(money: Money | undefined): string {
  if (!money) {
    return "the selected price";
  }
  if (money.display) {
    return money.display;
  }
  if (money.amount_minor !== undefined) {
    return `${money.amount_minor} ${money.currency} minor units`;
  }
  return `${money.currency} ${money.type ?? "unknown"} price`;
}

function formatOptionalMoney(money: Money | undefined): string | undefined {
  return money ? formatMoney(money) : undefined;
}

function idempotencyConflict<T>(): AdapterResult<T> {
  return {
    ok: false,
    problem: {
      code: "idempotency_conflict",
      message: "idempotency_key was reused with a different booking payload",
      retryable: false
    }
  };
}

function problemFromCreateException<T>(error: unknown): AdapterResult<T> {
  logCreateException(error);
  if (error instanceof StarterAdapterHttpError) {
    const rateLimited = error.status === 429;
    return {
      ok: false,
      problem: {
        code: rateLimited ? "rate_limited" : "internal_adapter_error",
        message: `Target platform request failed during booking.create with HTTP ${error.status} at ${error.path}.`,
        retryable: rateLimited || error.status >= 500
      }
    };
  }

  return {
    ok: false,
    problem: {
      code: "internal_adapter_error",
      message: "Adapter starter booking.create failed before returning a platform result.",
      retryable: false
    }
  };
}

function logCreateException(error: unknown): void {
  if (error instanceof StarterAdapterHttpError) {
    console.error(`[adapter-starter] booking.create HTTP ${error.status} at ${error.path}`);
    return;
  }

  const name = error instanceof Error
    ? safeDiagnosticName(error.constructor.name || error.name)
    : typeof error;
  console.error(`[adapter-starter] booking.create threw ${name}`);
}

function safeDiagnosticName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$.-]{0,80}$/.test(name) ? name : "unknown";
}

function providerScopeProblem(input: BookingCreateInput): AdapterResult<CreateValidationContext> | undefined {
  const providerScope = input.mandate.provider_ids;
  if (!providerScope) {
    return undefined;
  }
  if (!input.provider_id) {
    return {
      ok: false,
      problem: {
        code: "provider_unknown",
        message: "Selected slot does not identify provider required by BookingMandate scope",
        retryable: false
      }
    };
  }
  if (!providerScope.includes(input.provider_id)) {
    return {
      ok: false,
      problem: {
        code: "provider_not_allowed",
        message: "Selected provider is outside BookingMandate scope",
        retryable: false
      }
    };
  }
  return undefined;
}

function authHeaders(credentials: StarterBookingAdapterCredentials | undefined): Record<string, string> {
  if (!credentials) {
    return {};
  }
  if (credentials.bearerToken) {
    return { authorization: `Bearer ${credentials.bearerToken}` };
  }
  if (credentials.apiKey) {
    return { "x-api-key": credentials.apiKey };
  }
  return {};
}

function captureUpstreamMeta(call: string, response: Response): UpstreamMeta {
  return {
    call,
    status: response.status,
    server: response.headers.get("server") ?? undefined,
    request_id: firstHeaderContaining(response.headers, "request-id"),
    api_version: response.headers.get("api-version") ?? response.headers.get("x-api-version") ?? undefined,
    deprecation: response.headers.get("deprecation") ?? undefined,
    sunset: response.headers.get("sunset") ?? undefined,
    ratelimit: rateLimitHeaders(response.headers)
  };
}

function firstHeaderContaining(headers: Headers, needle: string): string | undefined {
  for (const [name, value] of headers) {
    if (name.toLowerCase().includes(needle)) {
      return value;
    }
  }
  return undefined;
}

function rateLimitHeaders(headers: Headers): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (lower === "retry-after" || lower === "ratelimit" || lower === "ratelimit-policy" || lower.startsWith("x-ratelimit-")) {
      result[lower] = value;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function redactPathSegments(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => {
      const decoded = safeDecode(segment);
      const phoneCandidate = decoded.replace(/[\s().-]/g, "");
      if (/^\+?\d{7,15}$/.test(phoneCandidate) || decoded.includes("@")) {
        return ":redacted";
      }
      return segment;
    })
    .join("/");
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function requestTimeout(
  timeoutMs: number | undefined,
  sourceSignal: AbortSignal | null | undefined
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs === undefined) {
    return { signal: sourceSignal ?? undefined, cleanup: () => {} };
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("httpTimeoutMs must be a positive finite number");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromSource = () => {
    controller.abort(sourceSignal?.reason);
  };

  if (sourceSignal?.aborted) {
    controller.abort(sourceSignal.reason);
  } else {
    sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      sourceSignal?.removeEventListener("abort", abortFromSource);
    }
  };
}

export type StarterCustomer = Customer;
