import type {
  AdapterResult,
  AvailabilityFindInput,
  Booking,
  BookingAdapter,
  BookingCreateInput,
  BookingStatusInput,
  Customer,
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
import { OSBP_VERSION, validateMandate } from "@osbp/core";
import { createHash } from "node:crypto";

export interface StarterBookingAdapterConfig {
  apiBaseUrl: string;
  organizationId: string;
  credentials?: StarterBookingAdapterCredentials;
  idempotencyStorePath?: string;
}

export interface StarterBookingAdapterCredentials {
  apiKey?: string;
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
}

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

type JsonRecord = Record<string, unknown>;

export class StarterBookingAdapter implements BookingAdapter {
  readonly platform: PlatformIdentity = { vendor: "replace-me", api_version: "replace-me" };
  private lastUpstreamMeta: UpstreamMeta | undefined;
  private readonly idempotencyCache = new Map<string, IdempotencyEntry>();

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
     * - Return verification_not_supported when the platform has no verification
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
     * - Keep validateMandate exactly before the platform create call. The host
     *   does not enforce it for the adapter.
     * - Use input.idempotency_key only for the local cache or a platform-native
     *   idempotency primitive that is empirically confirmed. Do not pipe it into
     *   unrelated id-like fields.
     * - Map success into a human-readable Receipt with booking_id, then store
     *   the receipt in the local idempotency cache.
     * Worked example: packages/reference-backend/src/index.ts
     * SyntheticBookingAdapter.createBooking.
     */
    const payloadHash = stableHash(redactVerificationCode(input));
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

    return notImplemented("booking.create has not been mapped to the target platform API");
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
    const url = new URL(path, withTrailingSlash(this.config.apiBaseUrl));
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": `OSBP/${OSBP_VERSION} adapter-starter/${OSBP_VERSION} node/${process.versions.node.split(".")[0]}`,
        "x-osbp-source": `adapter-starter/${OSBP_VERSION}`,
        ...authHeaders(this.config.credentials),
        ...init.headers
      }
    });
    this.lastUpstreamMeta = captureUpstreamMeta(`${(init.method ?? "GET").toUpperCase()} ${url.pathname}`, response);

    if (!response.ok) {
      throw new StarterAdapterHttpError(response.status, response.statusText, url.pathname, await response.text());
    }

    return (await response.json()) as T;
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

function redactVerificationCode(input: BookingCreateInput): BookingCreateInput {
  return {
    ...input,
    verification_code: undefined
  };
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
    if (lower === "ratelimit" || lower === "ratelimit-policy" || lower.startsWith("x-ratelimit-")) {
      result[lower] = value;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export type StarterCustomer = Customer;
