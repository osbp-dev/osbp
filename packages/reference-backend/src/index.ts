import type {
  AdapterResult,
  AvailabilityFindInput,
  Booking,
  BookingAdapter,
  BookingCreateInput,
  BookingMandate,
  BookingStatusInput,
  Customer,
  LocationSchedule,
  Money,
  OperatingHours,
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERIFICATION_CODE = "123456";

export interface SyntheticBookingAdapterConfig {
  apiBaseUrl: string;
  organizationId: string;
  idempotencyStorePath?: string;
  now?: () => Date;
  newToken?: () => string;
}

export interface SyntheticBookingServer {
  url: string;
  close(): Promise<void>;
}

export interface ReferenceReadOnlySmokeResult {
  organization: OrganizationResponse;
  locations: LocationSchedule[];
  services: Service[];
  service: Service;
  policy: Policy;
  availabilityDate: string;
  slots: Slot[];
  checks: {
    mandate_reachability: SmokeCheck;
    happy_path_bookability: SmokeCheck;
  };
}

export interface SmokeCheck {
  passed: true;
  message: string;
}

export interface ReferenceOrganizationSeed {
  id: string;
  name: string;
  slug: string;
  country: string;
  currency: string;
  timezone: string;
  domain: string;
  phone: string;
  support_email: string;
  locations: ReferenceLocationSeed[];
  providers: ReferenceProviderSeed[];
  services: ReferenceServiceSeed[];
  allow_parallel_bookings?: boolean;
}

export interface ReferenceLocationSeed extends LocationSchedule {
  id: string;
  name: string;
  timezone: string;
  service_ids?: string[];
}

export interface ReferenceProviderSeed {
  id: string;
  name: string;
  image_url?: string;
  has_portfolio?: boolean;
  schedule_ids: string[];
  service_ids?: string[];
}

export interface ReferenceServiceSeed extends Service {
  id: string;
  name: string;
  duration: string;
  price: Money;
  branch: string;
  schedule_ids: string[];
  provider_ids?: string[];
  policy: ReferencePolicySeed;
}

export type ReferencePolicySeed = Omit<Policy, "service_id" | "organization">;

export interface OrganizationResponse {
  id: string;
  name: string;
  slug: string;
  domain: string;
  phone: string;
  support_email: string;
  timezone: string;
  currency: string;
  country: string;
  total_locations: number;
}

type JsonRecord = Record<string, unknown>;

interface IdempotencyEntry {
  payloadHash: string;
  result: AdapterResult<Receipt>;
  booking: Booking;
}

interface InFlightBooking {
  payloadHash: string;
  promise: Promise<AdapterResult<Receipt>>;
}

interface ServerBookingRecord extends Booking {
  organization_id: string;
}

interface ServerState {
  organizations: Map<string, ReferenceOrganizationSeed>;
  bookings: Map<string, ServerBookingRecord>;
  idempotency: Map<string, Map<string, NativeIdempotencyEntry>>;
  scenarios: Map<string, "requires_verification" | "slot_taken" | "rate_limited">;
  verified: Set<string>;
  bookingCounter: number;
}

interface NativeIdempotencyEntry {
  payloadHash: string;
  status: number;
  body: unknown;
}

export class SyntheticBookingAdapter implements BookingAdapter {
  readonly platform: PlatformIdentity = { vendor: "osbp-reference-backend", api_version: "v1" };
  private lastUpstreamMeta: UpstreamMeta | undefined;
  private readonly idempotencyCache: Map<string, IdempotencyEntry>;
  private readonly inFlightBookings = new Map<string, InFlightBooking>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  get upstreamMeta(): UpstreamMeta | undefined {
    return this.lastUpstreamMeta;
  }

  constructor(readonly config: SyntheticBookingAdapterConfig) {
    this.idempotencyCache = loadIdempotencyStore(config.idempotencyStorePath);
  }

  async resolveOrganization(): Promise<AdapterResult<OrganizationResponse>> {
    try {
      return ok(await this.getJson<OrganizationResponse>(`/v1/organizations/${this.config.organizationId}`));
    } catch (error) {
      return problemFromError("reference_organization_failed", error);
    }
  }

  async listLocations(): Promise<AdapterResult<LocationSchedule[]>> {
    try {
      return ok(await this.getJson<LocationSchedule[]>(`/v1/organizations/${this.config.organizationId}/locations`));
    } catch (error) {
      return problemFromError("reference_locations_failed", error);
    }
  }

  async listServices(): Promise<AdapterResult<Service[]>> {
    try {
      return ok(await this.getJson<Service[]>(`/v1/organizations/${this.config.organizationId}/services`));
    } catch (error) {
      return problemFromError("reference_services_failed", error);
    }
  }

  async describeService(input: ServiceDescribeInput): Promise<AdapterResult<Service>> {
    try {
      const serviceId = input.service_id ?? await this.defaultServiceId();
      return ok(await this.getJson<Service>(`/v1/organizations/${this.config.organizationId}/services/${encodeURIComponent(serviceId)}`));
    } catch (error) {
      return problemFromError("reference_service_failed", error);
    }
  }

  async findAvailability(input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>> {
    try {
      const serviceId = input.service_id ?? await this.defaultServiceId();
      const query = new URLSearchParams({
        serviceId,
        date: input.date
      });
      if (input.schedule_id) {
        query.set("scheduleId", input.schedule_id);
      }
      if (input.provider_id) {
        query.set("providerId", input.provider_id);
      }

      return ok(
        await this.getJson<Slot[]>(
          `/v1/organizations/${this.config.organizationId}/availability?${query.toString()}`
        )
      );
    } catch (error) {
      return problemFromError("reference_availability_failed", error);
    }
  }

  async explainPolicy(input: PolicyExplainInput): Promise<AdapterResult<Policy>> {
    try {
      const serviceId = input.service_id ?? await this.defaultServiceId();
      return ok(await this.getJson<Policy>(`/v1/organizations/${this.config.organizationId}/policies/${encodeURIComponent(serviceId)}`));
    } catch (error) {
      return problemFromError("reference_policy_failed", error);
    }
  }

  async sendVerification(input: VerificationSendInput): Promise<AdapterResult<VerificationChallenge>> {
    try {
      return ok(
        await this.postJson<VerificationChallenge>(
          `/v1/organizations/${this.config.organizationId}/verifications/send`,
          input
        )
      );
    } catch (error) {
      return problemFromError("reference_verification_send_failed", error);
    }
  }

  async verifyCode(input: VerificationVerifyInput): Promise<AdapterResult<VerificationChallenge>> {
    try {
      return ok(
        await this.postJson<VerificationChallenge>(
          `/v1/organizations/${this.config.organizationId}/verifications/verify`,
          input
        )
      );
    } catch (error) {
      return problemFromError("reference_verification_verify_failed", error);
    }
  }

  async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    const payloadHash = stableHash(redactVerificationCode(input));
    const cached = this.idempotencyCache.get(input.idempotency_key);
    if (cached) {
      return cached.payloadHash === payloadHash ? cached.result : idempotencyConflict();
    }

    const inFlight = this.inFlightBookings.get(input.idempotency_key);
    if (inFlight) {
      return inFlight.payloadHash === payloadHash ? inFlight.promise : idempotencyConflict();
    }

    const attempt = this.performBooking(input, payloadHash);
    this.inFlightBookings.set(input.idempotency_key, { payloadHash, promise: attempt });
    return attempt;
  }

  async getBooking(input: BookingStatusInput): Promise<AdapterResult<Booking>> {
    const cachedBooking = [...this.idempotencyCache.values()]
      .map((entry) => entry.booking)
      .find((booking) => booking.id === input.booking_id);
    if (cachedBooking) {
      return ok(cachedBooking);
    }

    if (!input.booking_id) {
      return problem("booking_not_found", "booking_id is required to read a reference booking", false);
    }

    try {
      return ok(
        await this.getJson<Booking>(
          `/v1/organizations/${this.config.organizationId}/bookings/${encodeURIComponent(input.booking_id)}`
        )
      );
    } catch (error) {
      if (error instanceof SyntheticHttpError && error.status === 404) {
        return problem("booking_not_found", "No reference booking matches the supplied booking_id", false);
      }
      return problemFromError("reference_booking_status_failed", error);
    }
  }

  private async performBooking(input: BookingCreateInput, payloadHash: string): Promise<AdapterResult<Receipt>> {
    try {
      const service = await this.describeService({ service_id: input.service_id });
      if (!service.ok) {
        return service;
      }

      const policy = await this.explainPolicy({ service_id: input.service_id });
      if (!policy.ok) {
        return policy;
      }

      const slot = await this.resolveCreateSlot(input, service.value);
      if (!slot.ok) {
        return slot;
      }

      const validation = validateMandate({
        mandate: input.mandate,
        action: "booking.create",
        organization_id: this.config.organizationId,
        service: service.value,
        slot: slot.value,
        policy: policy.value,
        now: this.config.now?.()
      });
      if (!validation.ok) {
        return { ok: false, problem: validation.problem };
      }

      const approvalGate = requireApproval({
        approval: input.approval,
        payloadHash,
        summary: bookingApprovalSummary(input, service.value, slot.value, policy.value),
        store: this.pendingApprovals,
        now: (this.config.now?.() ?? new Date()).getTime(),
        newToken: this.config.newToken ?? randomUUID
      });
      if (!approvalGate.ok) {
        return approvalGate;
      }

      try {
        const response = await this.postJson<BookingCreateResponse>(
          `/v1/organizations/${this.config.organizationId}/bookings`,
          input,
          { "idempotency-key": input.idempotency_key }
        );
        const booking = response.booking;
        const result = ok<Receipt>(response.receipt);
        this.rememberIdempotentResult(input.idempotency_key, {
          payloadHash,
          result,
          booking
        });
        this.pendingApprovals.delete(payloadHash);
        return result;
      } catch (error) {
        if (error instanceof SyntheticHttpError && error.status === 428) {
          return problem("requires_verification", "Reference backend requires customer verification before booking", true);
        }
        if (error instanceof SyntheticHttpError && error.status === 409) {
          return problem("slot_taken", "Reference backend reports that the selected slot is no longer available", true);
        }
        if (error instanceof SyntheticHttpError && error.status === 429) {
          return problem("rate_limited", "Reference backend rate limited the booking request", true);
        }
        return problemFromError("reference_booking_create_failed", error);
      }
    } catch (error) {
      return problemFromError("reference_booking_create_failed", error);
    } finally {
      this.inFlightBookings.delete(input.idempotency_key);
    }
  }

  private async resolveCreateSlot(input: BookingCreateInput, service: Service): Promise<AdapterResult<Slot>> {
    const availability = await this.findAvailability({
      service_id: input.service_id,
      schedule_id: input.schedule_id,
      date: input.date,
      provider_id: input.provider_id
    });
    if (!availability.ok) {
      return availability;
    }

    const startsAtLocal = `${input.date}T${input.time.length === 5 ? `${input.time}:00` : input.time}`;
    let candidates = availability.value;
    if (candidates.length === 0 && input.provider_id) {
      const unscopedAvailability = await this.findAvailability({
        service_id: input.service_id,
        schedule_id: input.schedule_id,
        date: input.date
      });
      if (!unscopedAvailability.ok) {
        return unscopedAvailability;
      }
      candidates = unscopedAvailability.value;
    }

    const slot = candidates.find((candidate) =>
      candidate.service_id === input.service_id &&
      candidate.schedule_id === input.schedule_id &&
      candidate.provider_id === input.provider_id &&
      candidate.starts_at_local === startsAtLocal
    );
    const requestedProviderSlot = candidates.find((candidate) =>
      candidate.service_id === input.service_id &&
      candidate.schedule_id === input.schedule_id &&
      candidate.starts_at_local === startsAtLocal
    );
    if (!slot && !requestedProviderSlot) {
      return problem("slot_taken", "Selected slot is no longer available in the reference backend", true);
    }

    return ok({
      ...(slot ?? requestedProviderSlot),
      provider_id: slot?.provider_id ?? input.provider_id,
      provider_name: slot?.provider_name,
      provider_image_url: slot?.provider_image_url,
      provider_has_portfolio: slot?.provider_has_portfolio,
      price: (slot ?? requestedProviderSlot)?.price ?? service.price
    } as Slot);
  }

  private async defaultServiceId(): Promise<string> {
    const services = await this.listServices();
    if (!services.ok || !services.value[0]) {
      throw new SyntheticAdapterError("Reference backend has no services for this organization");
    }
    return services.value[0].id;
  }

  private async getJson<T>(pathWithQuery: string): Promise<T> {
    const url = new URL(pathWithQuery, withTrailingSlash(this.config.apiBaseUrl));
    return this.requestJson<T>(url, { method: "GET" });
  }

  private async postJson<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, withTrailingSlash(this.config.apiBaseUrl));
    return this.requestJson<T>(url, {
      method: "POST",
      body: JSON.stringify(dropUndefined(body)),
      headers
    });
  }

  private async requestJson<T>(url: URL, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": `OSBP/${OSBP_VERSION} reference-backend/${OSBP_VERSION} node/${process.versions.node.split(".")[0]}`,
        "x-osbp-source": `reference-backend/${OSBP_VERSION}`,
        ...init.headers
      }
    });
    this.lastUpstreamMeta = captureUpstreamMeta(`${(init.method ?? "GET").toUpperCase()} ${url.pathname}`, response);

    if (!response.ok) {
      throw new SyntheticHttpError(response.status, response.statusText, url.pathname, await response.text());
    }

    return (await response.json()) as T;
  }

  private rememberIdempotentResult(key: string, entry: IdempotencyEntry): void {
    this.idempotencyCache.set(key, entry);
    saveIdempotencyStore(this.config.idempotencyStorePath, this.idempotencyCache);
  }
}

export async function runReadOnlySmoke(
  adapter: SyntheticBookingAdapter
): Promise<AdapterResult<ReferenceReadOnlySmokeResult>> {
  const organization = await adapter.resolveOrganization();
  if (!organization.ok) {
    return organization;
  }

  const locations = await adapter.listLocations();
  if (!locations.ok) {
    return locations;
  }

  const services = await adapter.listServices();
  if (!services.ok) {
    return services;
  }

  const service = services.value.find((candidate) =>
    candidate.price?.amount_minor !== undefined &&
    candidate.requires_consultation !== true
  ) ?? services.value[0];
  if (!service) {
    return problem("missing_smoke_fixture", "Reference smoke needs at least one service", false);
  }

  const described = await adapter.describeService({ service_id: service.id });
  if (!described.ok) {
    return described;
  }

  const policy = await adapter.explainPolicy({ service_id: service.id });
  if (!policy.ok) {
    return policy;
  }

  const mandateReachability = checkMandateReachability(described.value, policy.value);
  if (!mandateReachability.ok) {
    return mandateReachability;
  }

  const bookableFixture = checkHappyPathFixtureSupported(described.value, policy.value);
  if (!bookableFixture.ok) {
    return bookableFixture;
  }

  let availabilityDate = nextDateIso(1);
  let slots: AdapterResult<Slot[]> = ok([]);
  for (let offset = 1; offset <= 14; offset += 1) {
    availabilityDate = nextDateIso(offset);
    slots = await adapter.findAvailability({
      service_id: described.value.id,
      date: availabilityDate
    });
    if (!slots.ok || slots.value.length > 0) {
      break;
    }
  }

  if (!slots.ok) {
    return slots;
  }

  if (slots.value[0]) {
    const slotShape = checkAvailabilitySlotShape(slots.value[0]);
    if (!slotShape.ok) {
      return slotShape;
    }
  }

  const bookability = checkHappyPathBookability({
    organization: organization.value,
    service: described.value,
    policy: policy.value,
    slots: slots.value
  });
  if (!bookability.ok) {
    return bookability;
  }

  return ok({
    organization: organization.value,
    locations: locations.value,
    services: services.value,
    service: described.value,
    policy: policy.value,
    availabilityDate,
    slots: slots.value,
    checks: {
      mandate_reachability: mandateReachability.value,
      happy_path_bookability: bookability.value
    }
  });
}

export async function startSyntheticBookingServer(
  seeds: readonly ReferenceOrganizationSeed[] = REFERENCE_ORGANIZATIONS
): Promise<SyntheticBookingServer> {
  const state: ServerState = {
    organizations: new Map(seeds.map((seed) => [seed.id, seed])),
    bookings: new Map(),
    idempotency: new Map(),
    scenarios: new Map(),
    verified: new Set(),
    bookingCounter: 0
  };
  const server = createServer((request, response) => {
    void routeRequest(state, request, response).catch((error: unknown) => {
      writeJson(response, 500, {
        problem: {
          code: "internal_adapter_error",
          message: error instanceof Error ? error.message : String(error)
        }
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
}

async function routeRequest(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const method = request.method ?? "GET";
  const segments = url.pathname.split("/").filter(Boolean);

  if (method === "POST" && url.pathname === "/test/scenarios") {
    const body = asRecord(await readJson(request));
    const organizationId = stringField(body, "organization_id");
    const nextCreate = stringField(body, "next_create");
    if (!organizationId || !isScenario(nextCreate)) {
      writeJson(response, 400, { problem: { code: "invalid_test_scenario", message: "Bad test scenario" } });
      return;
    }
    state.scenarios.set(organizationId, nextCreate);
    response.writeHead(204);
    response.end();
    return;
  }

  if (segments[0] !== "v1" || segments[1] !== "organizations" || !segments[2]) {
    writeJson(response, 404, { problem: { code: "not_found", message: "Unknown reference endpoint" } });
    return;
  }

  const organization = state.organizations.get(segments[2]);
  if (!organization) {
    writeJson(response, 404, { problem: { code: "organization_not_found", message: "Unknown organization" } });
    return;
  }

  if (method === "GET" && segments.length === 3) {
    writeJson(response, 200, organizationResponse(organization));
    return;
  }

  if (method === "GET" && segments[3] === "locations") {
    writeJson(response, 200, organization.locations.map(locationResponse));
    return;
  }

  if (method === "GET" && segments[3] === "services" && !segments[4]) {
    writeJson(response, 200, organization.services.map(serviceResponse));
    return;
  }

  if (method === "GET" && segments[3] === "services" && segments[4]) {
    const service = findService(organization, decodeURIComponent(segments[4]));
    if (!service) {
      writeJson(response, 404, { problem: { code: "service_not_found", message: "Unknown service" } });
      return;
    }
    writeJson(response, 200, serviceResponse(service));
    return;
  }

  if (method === "GET" && segments[3] === "policies" && segments[4]) {
    const service = findService(organization, decodeURIComponent(segments[4]));
    if (!service) {
      writeJson(response, 404, { problem: { code: "service_not_found", message: "Unknown service" } });
      return;
    }
    writeJson(response, 200, policyResponse(organization, service));
    return;
  }

  if (method === "GET" && segments[3] === "availability") {
    const serviceId = url.searchParams.get("serviceId") ?? organization.services[0]?.id;
    const date = url.searchParams.get("date");
    if (!serviceId || !date) {
      writeJson(response, 400, { problem: { code: "invalid_availability_request", message: "serviceId and date are required" } });
      return;
    }
    const service = findService(organization, serviceId);
    if (!service) {
      writeJson(response, 404, { problem: { code: "service_not_found", message: "Unknown service" } });
      return;
    }
    const slots = generateAvailability(organization, service, {
      date,
      scheduleId: url.searchParams.get("scheduleId") ?? undefined,
      providerId: url.searchParams.get("providerId") ?? undefined,
      bookedSlots: bookedSlotKeysForOrganization(state, organization)
    });
    // Lifecycle example (RFC 9745 Deprecation, RFC 8594 Sunset): the reference
    // marks this availability read as on a deprecation timeline so the full
    // metadata path is demonstrated end to end, including the lifecycle warning
    // an operator should act on. A real platform sets these only on an endpoint
    // it is actually retiring.
    writeJson(response, 200, slots, {
      deprecation: "@1781308800",
      sunset: "Tue, 01 Sep 2026 00:00:00 GMT"
    });
    return;
  }

  if (method === "POST" && segments[3] === "verifications" && segments[4] === "send") {
    const body = asRecord(await readJson(request));
    const purpose = stringField(body, "purpose") ?? `booking:${organization.id}`;
    writeJson(response, 200, {
      sent: true,
      method: "sms",
      purpose
    });
    return;
  }

  if (method === "POST" && segments[3] === "verifications" && segments[4] === "verify") {
    const body = asRecord(await readJson(request));
    const purpose = stringField(body, "purpose") ?? `booking:${organization.id}`;
    const customer = asRecord(body.customer);
    if (stringField(body, "code") !== VERIFICATION_CODE) {
      writeJson(response, 400, { problem: { code: "verification_failed", message: "Verification code did not match" } });
      return;
    }
    state.verified.add(verificationKey(organization.id, customer, purpose));
    writeJson(response, 200, {
      verified: true,
      method: "sms",
      purpose
    });
    return;
  }

  if (method === "POST" && segments[3] === "bookings") {
    await createServerBooking(state, organization, request, response);
    return;
  }

  if (method === "GET" && segments[3] === "bookings" && segments[4]) {
    const booking = state.bookings.get(decodeURIComponent(segments[4]));
    if (!booking || booking.organization_id !== organization.id) {
      writeJson(response, 404, { problem: { code: "booking_not_found", message: "Unknown booking" } });
      return;
    }
    writeJson(response, 200, stripOrganizationId(booking));
    return;
  }

  writeJson(response, 404, { problem: { code: "not_found", message: "Unknown reference endpoint" } });
}

async function createServerBooking(
  state: ServerState,
  organization: ReferenceOrganizationSeed,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const body = asRecord(await readJson(request)) as unknown as BookingCreateInput;
  const idempotencyKey = request.headers["idempotency-key"];
  if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
    writeJson(response, 400, { problem: { code: "missing_idempotency_key", message: "Idempotency-Key is required" } });
    return;
  }

  const payloadHash = stableHash(body);
  const orgIdempotency = getOrgIdempotency(state, organization.id);
  const cached = orgIdempotency.get(idempotencyKey);
  if (cached) {
    if (cached.payloadHash !== payloadHash) {
      writeJson(response, 409, { problem: { code: "idempotency_conflict", message: "Native idempotency conflict" } });
      return;
    }
    writeJson(response, cached.status, cached.body);
    return;
  }

  const scenario = state.scenarios.get(organization.id);
  if (scenario === "rate_limited") {
    state.scenarios.delete(organization.id);
    writeJson(response, 429, { problem: { code: "rate_limited", message: "Synthetic rate limit" } });
    return;
  }
  if (scenario === "slot_taken") {
    state.scenarios.delete(organization.id);
    writeJson(response, 409, { problem: { code: "slot_taken", message: "Synthetic slot conflict" } });
    return;
  }
  if (scenario === "requires_verification" && body.verification_code !== VERIFICATION_CODE) {
    writeJson(response, 428, { problem: { code: "requires_verification", message: "Synthetic verification required" } });
    return;
  }
  if (scenario === "requires_verification") {
    state.scenarios.delete(organization.id);
  }

  const service = findService(organization, body.service_id);
  if (!service) {
    writeJson(response, 404, { problem: { code: "service_not_found", message: "Unknown service" } });
    return;
  }

  const verificationMethod = service.policy.verification_method ?? "none";
  if (verificationMethod === "sms" || verificationMethod === "email") {
    const purpose = `booking:${organization.id}`;
    const customer = asRecord(body.customer);
    const customerVerified = state.verified.has(verificationKey(organization.id, customer, purpose));
    if (!customerVerified && body.verification_code === undefined) {
      writeJson(response, 428, { problem: { code: "requires_verification", message: "Synthetic verification required" } });
      return;
    }
    if (!customerVerified && body.verification_code !== VERIFICATION_CODE) {
      writeJson(response, 400, { problem: { code: "verification_failed", message: "Verification code did not match" } });
      return;
    }
  }

  const slots = generateAvailability(organization, service, {
    date: body.date,
    scheduleId: body.schedule_id,
    providerId: body.provider_id,
    bookedSlots: bookedSlotKeysForOrganization(state, organization)
  });
  const startsAtLocal = `${body.date}T${body.time.length === 5 ? `${body.time}:00` : body.time}`;
  const slot = slots.find((candidate) => candidate.starts_at_local === startsAtLocal);
  if (!slot) {
    writeJson(response, 409, { problem: { code: "slot_taken", message: "Selected slot is unavailable" } });
    return;
  }

  state.bookingCounter += 1;
  const booking: ServerBookingRecord = dropUndefined({
    id: syntheticBookingId(organization.id, state.bookingCounter),
    organization_id: organization.id,
    status: "booked",
    service_id: body.service_id,
    schedule_id: body.schedule_id,
    provider_id: body.provider_id,
    starts_at: slot.starts_at,
    starts_at_local: slot.starts_at_local,
    schedule_timezone: slot.schedule_timezone,
    customer_id: body.customer?.id
  }) as ServerBookingRecord;
  state.bookings.set(booking.id, booking);

  const receipt: Receipt = {
    id: syntheticReceiptId(booking.id),
    booking_id: booking.id,
    text: `Booked ${service.name} on ${body.date} at ${body.time}. Reference booking id: ${booking.id}.`
  };
  const responseBody: BookingCreateResponse = {
    booking: stripOrganizationId(booking),
    receipt
  };
  orgIdempotency.set(idempotencyKey, {
    payloadHash,
    status: 201,
    body: responseBody
  });
  writeJson(response, 201, responseBody);
}

function syntheticBookingId(organizationId: string, counter: number): string {
  const suffixes: Record<string, string> = {
    org_01jz7ay6r8dd6yskkpt8rvhk8z: "01jz7f2szt8h7q6m5n4p3r2v9k",
    org_01jz7jevggr5st9acrxfbexvzz: "01jz7f4vc6g9te2hd8bn1q5x3m",
    org_01jz7gmphxn33ertpvvx9y3yfh: "01jz7f65htw3yn9kc4s2mb8r7q",
    org_01jz731qszrrnysfpdypv1kkv7: "01jz7f7qb2ap4vd6e9kx0t3n5w"
  };
  const base = suffixes[organizationId] ?? "01jz7f9m6s0d2gv5p8qh4x1t3b";
  if (counter === 1) {
    return `bk_${base}`;
  }

  return `bk_${base}_${String(counter).padStart(4, "0")}`;
}

function syntheticReceiptId(bookingId: string): string {
  return `rcpt_${bookingId.replace(/^bk_/, "")}`;
}

interface BookingCreateResponse {
  booking: Booking;
  receipt: Receipt;
}

interface AvailabilityQuery {
  date: string;
  scheduleId?: string;
  providerId?: string;
  bookedSlots: Set<string>;
}

function generateAvailability(
  organization: ReferenceOrganizationSeed,
  service: ReferenceServiceSeed,
  query: AvailabilityQuery
): Slot[] {
  // The synthetic backend offers slots on any requested date regardless of the
  // schedule's operating hours: it exists to exercise the adapter contract, not
  // to model a real organization's calendar. schedule_hours is carried through as
  // descriptive metadata only; a real adapter must honor operating hours.
  const scheduleIds = query.scheduleId ? [query.scheduleId] : service.schedule_ids;
  const slots: Slot[] = [];

  for (const scheduleId of scheduleIds) {
    const location = organization.locations.find((candidate) => candidate.id === scheduleId);
    if (!location || !service.schedule_ids.includes(scheduleId)) {
      continue;
    }

    const providers = organization.providers.filter((provider) =>
      provider.schedule_ids.includes(scheduleId) &&
      (!provider.service_ids || provider.service_ids.includes(service.id)) &&
      (!service.provider_ids || service.provider_ids.includes(provider.id)) &&
      (!query.providerId || provider.id === query.providerId)
    );

    providers.forEach((provider) => {
      const providerIndex = organization.providers.findIndex((candidate) => candidate.id === provider.id);
      const time = providerIndex % 2 === 0 ? "09:00" : "10:30";
      const startsAtLocal = `${query.date}T${time}:00`;
      const slot: Slot = dropUndefined({
        id: [scheduleId, provider.id, service.id, startsAtLocal].join(":"),
        organization_id: organization.id,
        schedule_id: scheduleId,
        schedule_name: location.name,
        schedule_address: location.address,
        schedule_latitude: location.latitude,
        schedule_longitude: location.longitude,
        schedule_hours: location.hours,
        schedule_timezone: location.timezone,
        provider_id: provider.id,
        provider_name: provider.name,
        provider_image_url: provider.image_url,
        provider_has_portfolio: provider.has_portfolio,
        service_id: service.id,
        starts_at: wallClockToInstant(startsAtLocal, location.timezone),
        ends_at: wallClockToInstant(addDuration(startsAtLocal, service.duration), location.timezone),
        starts_at_local: startsAtLocal,
        ends_at_local: addDuration(startsAtLocal, service.duration),
        price: service.price,
        organization_name: organization.name
      }) as Slot;

      if (!query.bookedSlots.has(slotKey(slot))) {
        slots.push(slot);
      }
    });
  }

  return slots;
}

function organizationResponse(seed: ReferenceOrganizationSeed): OrganizationResponse {
  return {
    id: seed.id,
    name: seed.name,
    slug: seed.slug,
    domain: seed.domain,
    phone: seed.phone,
    support_email: seed.support_email,
    timezone: seed.timezone,
    currency: seed.currency,
    country: seed.country,
    total_locations: seed.locations.length
  };
}

function organizationContext(seed: ReferenceOrganizationSeed): NonNullable<Policy["organization"]> {
  return organizationResponse(seed);
}

function locationResponse(seed: ReferenceLocationSeed): LocationSchedule {
  return dropUndefined({
    id: seed.id,
    name: seed.name,
    slug: seed.slug,
    address: seed.address,
    timezone: seed.timezone,
    latitude: seed.latitude,
    longitude: seed.longitude,
    hours: seed.hours
  }) as LocationSchedule;
}

function serviceResponse(seed: ReferenceServiceSeed): Service {
  return dropUndefined({
    id: seed.id,
    name: seed.name,
    duration: seed.duration,
    price: seed.price,
    requires_consultation: seed.requires_consultation,
    options: seed.options
  }) as Service;
}

function policyResponse(organization: ReferenceOrganizationSeed, service: ReferenceServiceSeed): Policy {
  return dropUndefined({
    service_id: service.id,
    ...service.policy,
    organization: organizationContext(organization)
  }) as Policy;
}

function checkMandateReachability(service: Service, policy: Policy): AdapterResult<SmokeCheck> {
  const missing: string[] = [];
  if (!service.id) {
    missing.push("service.describe.id -> BookingMandate.service_ids");
  }
  if (!policy.organization?.id) {
    missing.push("policy.explain.organization.id -> BookingMandate.organization_id");
  }
  if (service.price?.amount_minor === undefined) {
    missing.push("service.describe.price.amount_minor -> BookingMandate.max_price");
  }
  if (policy.payment_requirement === undefined) {
    missing.push("policy.explain.payment_requirement -> BookingMandate.allow_policy_fee/max_extra_fee");
  }
  if (policy.payment_requirement === "deposit" && policy.deposit?.amount_minor === undefined) {
    missing.push("policy.explain.deposit.amount_minor -> BookingMandate.max_extra_fee");
  }
  if (missing.length > 0) {
    return problem(
      "missing_mandate_reachability",
      `Read-only smoke cannot construct BookingMandate scope from read tools; missing ${missing.join(", ")}`,
      false
    );
  }
  return ok({
    passed: true,
    message: "service.describe + policy.explain expose the fields needed to construct BookingMandate scope"
  });
}

function checkHappyPathFixtureSupported(service: Service, policy: Policy): AdapterResult<SmokeCheck> {
  if (service.requires_consultation === true) {
    return problem("unsupported_smoke_bookability_fixture", "Smoke service requires consultation", false);
  }
  if (policy.payment_requirement && policy.payment_requirement !== "none") {
    return problem("unsupported_smoke_bookability_fixture", "Smoke service requires payment", false);
  }
  return ok({
    passed: true,
    message: "configured service is eligible for the v0.1.0 happy-path bookability smoke"
  });
}

function checkAvailabilitySlotShape(slot: Slot): AdapterResult<SmokeCheck> {
  const failures: string[] = [];
  requireString(failures, "Slot.id", slot.id);
  requireString(failures, "Slot.organization_id", slot.organization_id);
  requireString(failures, "Slot.schedule_id", slot.schedule_id);
  requireString(failures, "Slot.service_id", slot.service_id);
  requireString(failures, "Slot.provider_id", slot.provider_id);
  requireString(failures, "Slot.starts_at_local", slot.starts_at_local);
  requireString(failures, "Slot.schedule_timezone", slot.schedule_timezone);
  requireInstant(failures, "Slot.starts_at", slot.starts_at);
  if (slot.price?.amount_minor === undefined) {
    failures.push("Slot.price.amount_minor expected fixed amount");
  }
  requireString(failures, "Slot.price.currency", slot.price?.currency);

  if (failures.length > 0) {
    return problem("smoke_shape_drift", `Reference slot shape drift: ${failures.join("; ")}`, false);
  }
  return ok({
    passed: true,
    message: "availability.find Slot canary matches required shape"
  });
}

function checkHappyPathBookability(input: {
  organization: OrganizationResponse;
  service: Service;
  policy: Policy;
  slots: Slot[];
}): AdapterResult<SmokeCheck> {
  if (input.slots.length === 0) {
    return problem("missing_smoke_bookability_slots", "Reference smoke found no slots", false);
  }

  for (const slot of input.slots) {
    const mandate = buildSmokeMandate(input.organization, input.service, slot);
    const validation = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: input.organization.id,
      service: input.service,
      slot,
      policy: input.policy
    });
    if (!validation.ok) {
      return problem(
        "smoke_bookability_validation_failed",
        `Smoke slot ${slot.id} failed validateMandate with ${validation.problem.code}`,
        false
      );
    }
  }

  return ok({
    passed: true,
    message: `validated ${input.slots.length} slot(s) against a constructed v0.1.0 BookingMandate`
  });
}

function buildSmokeMandate(organization: OrganizationResponse, service: Service, slot: Slot): BookingMandate {
  const currency = slot.price?.currency ?? service.price?.currency ?? organization.currency;
  const amount = Math.max(
    slot.price?.amount_minor ?? 0,
    service.price?.amount_minor ?? 0
  );
  return {
    id: "reference_smoke_mandate",
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    allowed_actions: ["booking.create"],
    organization_id: organization.id,
    service_ids: [service.id],
    provider_ids: slot.provider_id ? [slot.provider_id] : undefined,
    schedule_ids: [slot.schedule_id],
    earliest_start: slot.starts_at_local,
    latest_end: slot.ends_at_local ?? slot.starts_at_local,
    max_price: { amount_minor: amount, currency },
    allow_policy_fee: false,
    max_extra_fee: { amount_minor: 0, currency }
  };
}

function requireString(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${path} expected non-empty string`);
  }
}

function requireInstant(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "string" || !/Z$|[+-]\d{2}:?\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) {
    failures.push(`${path} expected RFC 3339 instant with offset`);
  }
}

export function wallClockToInstant(localISO: string, timeZone: string | undefined): string | undefined {
  if (!timeZone) {
    return undefined;
  }
  const guessUTC = new Date(`${localISO}Z`).getTime();
  if (!Number.isFinite(guessUTC)) {
    return undefined;
  }
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(guessUTC)).map((part) => [part.type, part.value]));
  const asTimeZone = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return new Date(guessUTC - (asTimeZone - guessUTC)).toISOString();
}

function addDuration(localISO: string, duration: string): string {
  const minutes = durationMinutes(duration);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(localISO);
  if (!match) {
    return localISO;
  }
  const [, date, hour, minute, second] = match;
  const totalMinutes = Number(hour) * 60 + Number(minute) + minutes;
  const endHour = Math.floor(totalMinutes / 60);
  const endMinute = totalMinutes % 60;
  return `${date}T${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}:${second}`;
}

function durationMinutes(duration: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(duration);
  if (!match) {
    return 0;
  }
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
}

function findService(
  organization: ReferenceOrganizationSeed,
  serviceId: string
): ReferenceServiceSeed | undefined {
  return organization.services.find((service) => service.id === serviceId);
}

function bookingSlotKey(booking: Booking): string {
  return [booking.schedule_id, booking.provider_id, booking.service_id, booking.starts_at_local].join(":");
}

function slotKey(slot: Slot): string {
  return [slot.schedule_id, slot.provider_id, slot.service_id, slot.starts_at_local].join(":");
}

function bookedSlotKeysForOrganization(
  state: ServerState,
  organization: ReferenceOrganizationSeed
): Set<string> {
  if (organization.allow_parallel_bookings === true) {
    return new Set();
  }
  return new Set(
    [...state.bookings.values()]
      .filter((booking) => booking.organization_id === organization.id)
      .map(bookingSlotKey)
  );
}

function stripOrganizationId(booking: ServerBookingRecord): Booking {
  const { organization_id: _organizationId, ...rest } = booking;
  return rest;
}

function verificationKey(organizationId: string, customer: JsonRecord, purpose: string): string {
  return [
    organizationId,
    purpose,
    stringField(customer, "id") ?? "",
    stringField(customer, "phone") ?? "",
    stringField(customer, "email") ?? ""
  ].join(":");
}

function getOrgIdempotency(state: ServerState, organizationId: string): Map<string, NativeIdempotencyEntry> {
  let entries = state.idempotency.get(organizationId);
  if (!entries) {
    entries = new Map();
    state.idempotency.set(organizationId, entries);
  }
  return entries;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

// The applied API version this reference echoes on every response (the Square
// version-discipline pattern). Bump it to demonstrate the api-version drift
// signal an OSBP adapter records.
const REFERENCE_API_VERSION = "2026-06-13";

// The reference backend is the IDEAL platform: every response carries the full
// observability and versioning header set OSBP asks real platforms for, so the
// adapter's UpstreamMeta capture and audit drift-provenance work end to end. A
// real, minimal platform sends almost none of this, so the
// reference is where the complete metadata path is demonstrated.
function idealResponseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    server: "osbp-reference-backend/0.1.0",
    "api-version": REFERENCE_API_VERSION,
    "x-request-id": randomUUID(),
    ratelimit: "limit=120, remaining=119, reset=60",
    "ratelimit-policy": "120;w=60",
    ...extra
  };
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  response.writeHead(status, idealResponseHeaders(extraHeaders));
  response.end(`${JSON.stringify(dropUndefined(body))}\n`);
}

// Capture the full per-call response metadata set an OSBP adapter records for
// the audit channel: Server (infra fingerprint), the api-version echo, the
// first request-id header, Deprecation (RFC 9745), Sunset (RFC 8594), and
// RateLimit headers. Mirrors the capture a real platform adapter performs
// so the reference demonstrates the complete metadata path, not a subset.
function captureUpstreamMeta(call: string, response: Response): UpstreamMeta {
  const meta: UpstreamMeta = { call, status: response.status };

  const server = response.headers.get("server");
  if (server) {
    meta.server = server;
  }
  const apiVersion = response.headers.get("api-version") ?? response.headers.get("x-api-version");
  if (apiVersion) {
    meta.api_version = apiVersion;
  }
  const deprecation = response.headers.get("deprecation");
  if (deprecation) {
    meta.deprecation = deprecation;
  }
  const sunset = response.headers.get("sunset");
  if (sunset) {
    meta.sunset = sunset;
  }

  for (const [name, value] of response.headers) {
    if (!meta.request_id && name.includes("request-id")) {
      meta.request_id = value;
    }
    if (name === "ratelimit" || name === "ratelimit-policy" || name.startsWith("x-ratelimit-")) {
      (meta.ratelimit ??= {})[name] = value;
    }
  }

  return meta;
}

class SyntheticAdapterError extends Error {
  override name = "SyntheticAdapterError";
}

class SyntheticHttpError extends SyntheticAdapterError {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly path: string,
    readonly body: string
  ) {
    super(`Reference backend ${status} ${statusText} for ${path}`);
  }
}

function problem<T>(code: string, message: string, retryable: boolean): AdapterResult<T> {
  return {
    ok: false,
    problem: {
      code,
      message,
      retryable
    }
  };
}

function problemFromError<T>(code: string, error: unknown): AdapterResult<T> {
  if (error instanceof SyntheticHttpError && error.status === 429) {
    return problem("rate_limited", error.message, true);
  }
  return {
    ok: false,
    problem: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: error instanceof SyntheticHttpError ? error.status >= 500 : false
    }
  };
}

function idempotencyConflict(): AdapterResult<Receipt> {
  return problem("idempotency_conflict", "idempotency_key was reused with a different booking payload", false);
}

function ok<T>(value: T): AdapterResult<T> {
  return { ok: true, value };
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function loadIdempotencyStore(path: string | undefined): Map<string, IdempotencyEntry> {
  const resolved = resolveIdempotencyStorePath(path);
  if (!resolved) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, IdempotencyEntry>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function saveIdempotencyStore(path: string | undefined, entries: Map<string, IdempotencyEntry>): void {
  const resolved = resolveIdempotencyStorePath(path);
  if (!resolved) {
    return;
  }
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
}

function resolveIdempotencyStorePath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  return isAbsolute(path) ? path : join(PACKAGE_ROOT, path);
}

function redactVerificationCode(input: BookingCreateInput): unknown {
  // approval and verification_code are excluded so a tokenless first call and
  // its approved/verified retry hash to the same logical booking attempt.
  const { verification_code: _verificationCode, approval: _approval, ...payload } = input;
  return payload;
}

function bookingApprovalSummary(input: BookingCreateInput, service: Service, slot: Slot, policy: Policy): string {
  const price = slot.price ?? service.price;
  const priceText =
    price?.display ??
    (price?.amount_minor !== undefined && price.currency
      ? formatMoney(price.amount_minor, price.currency)
      : "an unlisted price");
  const payment =
    policy.payment_requirement && policy.payment_requirement !== "none"
      ? `Payment required: ${policy.payment_requirement}.`
      : "No upfront payment or deposit is required to book.";
  return (
    `Book ${service.name} for ${priceText} on ${input.date} at ${input.time} ` +
    `with provider ${input.provider_id} at schedule ${input.schedule_id}. ${payment}`
  );
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (!isRecord(value)) {
    return JSON.stringify(value);
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function dropUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(dropUndefined);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, dropUndefined(entry)])
  );
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScenario(value: unknown): value is "requires_verification" | "slot_taken" | "rate_limited" {
  return value === "requires_verification" || value === "slot_taken" || value === "rate_limited";
}

function nextDateIso(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function money(amountMinor: number, currency: string): Money {
  return {
    amount_minor: amountMinor,
    currency,
    type: "fixed",
    display: formatMoney(amountMinor, currency)
  };
}

function nonFixedMoney(currency: string, type: "insurance_dependent" | "quote_required" | "unknown"): Money {
  return {
    currency,
    type,
    display:
      type === "insurance_dependent"
        ? "Insurance dependent"
        : type === "quote_required"
          ? "Quote required"
          : "Unknown"
  };
}

function formatMoney(amountMinor: number, currency: string): string {
  const major = amountMinor / 10 ** minorUnitExponent(currency);
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(major);
}

const CURRENCY_MINOR_UNIT_EXPONENT: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3
};

function minorUnitExponent(currency: string): number {
  return CURRENCY_MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

function weekdayHours(open: string, close: string): OperatingHours[] {
  return [1, 2, 3, 4, 5].map((day) => ({
    day,
    open,
    close
  }));
}

function basePolicy(input: {
  payment_requirement?: Policy["payment_requirement"];
  deposit?: Money;
  verification_method?: Policy["verification_method"];
  cancellation_fee?: Money;
  no_show_fee?: Money;
}): ReferencePolicySeed {
  return {
    cancellation_enabled: true,
    cancellation_window: "PT24H",
    cancellation_note: "Cancel at least 24 hours before the appointment.",
    late_grace: "PT15M",
    cancellation_fee: input.cancellation_fee,
    no_show_fee: input.no_show_fee,
    payment_requirement: input.payment_requirement ?? "none",
    deposit: input.deposit,
    verification_method: input.verification_method ?? "none"
  };
}

export const REFERENCE_CONFORMANCE_FIXTURES = {
  organization_id: "conformance_co",
  schedule_id: "conformance_main",
  provider_id: "conformance_provider_grace",
  date: "2030-05-02",
  time: "10:30",
  customer: {
    id: "conformance_customer",
    phone: "+15555550100",
    email: "customer@example.com",
    display_name: "Morgan Patel"
  },
  services: {
    fixed_usd: "conformance_fixed_usd",
    fixed_eur: "conformance_fixed_eur",
    fixed_gbp: "conformance_fixed_gbp",
    fixed_jpy: "conformance_fixed_jpy",
    fixed_kwd: "conformance_fixed_kwd",
    insurance_dependent: "conformance_insurance_dependent",
    quote_required: "conformance_quote_required",
    consultation: "conformance_consultation",
    deposit: "conformance_deposit",
    full_prepay: "conformance_full_prepay",
    unknown_payment: "conformance_unknown_payment",
    verification: "conformance_verification"
  },
  expected_prices: {
    conformance_fixed_usd: { amount_minor: 9500, currency: "USD" },
    conformance_fixed_eur: { amount_minor: 9000, currency: "EUR" },
    conformance_fixed_gbp: { amount_minor: 8000, currency: "GBP" },
    conformance_fixed_jpy: { amount_minor: 12000, currency: "JPY" },
    conformance_fixed_kwd: { amount_minor: 12500, currency: "KWD" }
  }
};

export const REFERENCE_CONFORMANCE_ORGANIZATION: ReferenceOrganizationSeed = {
  id: REFERENCE_CONFORMANCE_FIXTURES.organization_id,
  name: "OSBP Conformance Fixture",
  slug: "osbp-conformance-fixture",
  country: "US",
  currency: "USD",
  timezone: "America/New_York",
  domain: "conformance.example",
  phone: "+12125550190",
  support_email: "support@conformance.example",
  allow_parallel_bookings: true,
  locations: [
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.schedule_id,
      name: "Conformance Main Desk",
      slug: "conformance-main-desk",
      address: "100 Fixture Ave, New York, NY 10001",
      timezone: "America/New_York",
      latitude: 40.7501,
      longitude: -73.997,
      hours: weekdayHours("09:00", "17:00")
    }
  ],
  providers: [
    { id: "conformance_provider_ada", name: "Ada Fixture", schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id] },
    { id: REFERENCE_CONFORMANCE_FIXTURES.provider_id, name: "Grace Fixture", schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id] }
  ],
  services: [
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.fixed_usd,
      name: "Fixed USD service",
      duration: "PT45M",
      price: money(9500, "USD"),
      options: [
        {
          id: "conformance_fixed_usd_extra_time",
          name: "Extra 15 minutes",
          duration: "PT15M",
          price: money(2500, "USD")
        }
      ],
      branch: "conformance: fixed USD",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({})
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.fixed_eur,
      name: "Fixed EUR service",
      duration: "PT45M",
      price: money(9000, "EUR"),
      branch: "conformance: fixed EUR",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({})
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.fixed_gbp,
      name: "Fixed GBP service",
      duration: "PT45M",
      price: money(8000, "GBP"),
      branch: "conformance: fixed GBP",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({})
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.fixed_jpy,
      name: "Fixed JPY service",
      duration: "PT45M",
      price: money(12000, "JPY"),
      branch: "conformance: fixed JPY",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({})
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.fixed_kwd,
      name: "Fixed KWD service",
      duration: "PT45M",
      price: money(12500, "KWD"),
      branch: "conformance: fixed KWD",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({})
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.insurance_dependent,
      name: "Insurance-dependent service",
      duration: "PT45M",
      price: nonFixedMoney("USD", "insurance_dependent"),
      branch: "conformance: insurance-dependent price",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({})
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.quote_required,
      name: "Quote-required service",
      duration: "PT45M",
      price: nonFixedMoney("USD", "quote_required"),
      branch: "conformance: quote-required price",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({})
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.consultation,
      name: "Consultation service",
      duration: "PT45M",
      price: money(5000, "USD"),
      requires_consultation: true,
      branch: "conformance: consultation handoff",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({})
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.deposit,
      name: "Deposit service",
      duration: "PT45M",
      price: money(10000, "USD"),
      branch: "conformance: deposit handoff",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({ payment_requirement: "deposit", deposit: money(2500, "USD") })
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.full_prepay,
      name: "Full-prepay service",
      duration: "PT45M",
      price: money(11000, "USD"),
      branch: "conformance: full prepay handoff",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({ payment_requirement: "full_prepay" })
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.unknown_payment,
      name: "Unknown-payment service",
      duration: "PT45M",
      price: money(12000, "USD"),
      branch: "conformance: unknown payment",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({ payment_requirement: "unknown" })
    },
    {
      id: REFERENCE_CONFORMANCE_FIXTURES.services.verification,
      name: "Verification-gated service",
      duration: "PT45M",
      price: money(2500, "USD"),
      branch: "conformance: policy-driven verification",
      schedule_ids: [REFERENCE_CONFORMANCE_FIXTURES.schedule_id],
      policy: basePolicy({ verification_method: "sms" })
    }
  ]
};

export const REFERENCE_ORGANIZATIONS: ReferenceOrganizationSeed[] = [
  {
    id: "org_01jz7ay6r8dd6yskkpt8rvhk8z",
    name: "Carolyn's Dental",
    slug: "carolyns-dental",
    country: "US",
    currency: "USD",
    timezone: "America/New_York",
    domain: "carolyns-dental.example",
    phone: "+12125550100",
    support_email: "care@carolyns-dental.example",
    locations: [
      {
        id: "dental_midtown",
        name: "Midtown Dental Suite",
        slug: "midtown-dental-suite",
        address: "245 E 40th St, New York, NY 10016",
        timezone: "America/New_York",
        latitude: 40.7481,
        longitude: -73.9725,
        hours: weekdayHours("08:00", "17:00")
      }
    ],
    providers: [
      { id: "dental_dr_lee", name: "Dr. Mina Lee", schedule_ids: ["dental_midtown"], has_portfolio: true },
      { id: "dental_hygienist_rivera", name: "Sam Rivera, RDH", schedule_ids: ["dental_midtown"] }
    ],
    services: [
      {
        id: "dental_cleaning",
        name: "Regular cleaning",
        duration: "PT45M",
        price: money(12000, "USD"),
        branch: "happy path",
        schedule_ids: ["dental_midtown"],
        policy: basePolicy({ no_show_fee: money(5000, "USD") })
      },
      {
        id: "dental_checkup_exam",
        name: "Checkup and exam",
        duration: "PT30M",
        price: money(15000, "USD"),
        branch: "happy path",
        schedule_ids: ["dental_midtown"],
        policy: basePolicy({ no_show_fee: money(5000, "USD") })
      },
      {
        id: "dental_toothache_emergency",
        name: "Toothache emergency evaluation",
        duration: "PT30M",
        price: money(18000, "USD"),
        branch: "urgent happy path",
        schedule_ids: ["dental_midtown"],
        provider_ids: ["dental_dr_lee"],
        policy: basePolicy({ no_show_fee: money(5000, "USD") })
      },
      {
        id: "dental_xrays",
        name: "Dental x-rays",
        duration: "PT20M",
        price: money(8000, "USD"),
        branch: "happy path",
        schedule_ids: ["dental_midtown"],
        policy: basePolicy({ no_show_fee: money(5000, "USD") })
      },
      {
        id: "dental_teeth_whitening",
        name: "Teeth whitening",
        duration: "PT60M",
        price: money(25000, "USD"),
        branch: "happy path",
        schedule_ids: ["dental_midtown"],
        policy: basePolicy({ no_show_fee: money(5000, "USD") })
      },
      {
        id: "dental_filling",
        name: "Dental filling",
        duration: "PT60M",
        price: nonFixedMoney("USD", "insurance_dependent"),
        branch: "requires_user_confirmation: insurance_dependent price",
        schedule_ids: ["dental_midtown"],
        provider_ids: ["dental_dr_lee"],
        policy: basePolicy({ no_show_fee: money(5000, "USD") })
      },
      {
        id: "dental_crown",
        name: "Crown appointment",
        duration: "PT90M",
        price: money(120000, "USD"),
        branch: "requires_payment_handoff: deposit",
        schedule_ids: ["dental_midtown"],
        provider_ids: ["dental_dr_lee"],
        policy: basePolicy({ payment_requirement: "deposit", deposit: money(25000, "USD") })
      },
      {
        id: "dental_new_patient_exam",
        name: "Comprehensive new-patient exam",
        duration: "PT60M",
        price: money(20000, "USD"),
        requires_consultation: true,
        branch: "requires_consultation_handoff",
        schedule_ids: ["dental_midtown"],
        provider_ids: ["dental_dr_lee"],
        policy: basePolicy({})
      },
      {
        id: "dental_custom_treatment_plan",
        name: "Custom treatment plan review",
        duration: "PT30M",
        price: money(5000, "USD"),
        branch: "requires_user_confirmation: unknown payment",
        schedule_ids: ["dental_midtown"],
        provider_ids: ["dental_dr_lee"],
        policy: basePolicy({ payment_requirement: "unknown" })
      }
    ]
  },
  {
    id: "org_01jz7gmphxn33ertpvvx9y3yfh",
    name: "Gus' Notary",
    slug: "gus-notary",
    country: "US",
    currency: "USD",
    timezone: "America/New_York",
    domain: "gus-notary.example",
    phone: "+12125550150",
    support_email: "appointments@gus-notary.example",
    locations: [
      {
        id: "notary_office",
        name: "Midtown Notary Desk",
        slug: "midtown-notary-desk",
        address: "11 W 42nd St, New York, NY 10036",
        timezone: "America/New_York",
        latitude: 40.754,
        longitude: -73.9819,
        hours: weekdayHours("09:00", "18:00")
      },
      {
        id: "notary_online",
        name: "Online (remote notarization)",
        slug: "online-remote-notarization",
        timezone: "America/New_York",
        hours: weekdayHours("09:00", "18:00")
      }
    ],
    providers: [
      { id: "notary_chen", name: "Maya Chen, Notary Public", schedule_ids: ["notary_office", "notary_online"] },
      { id: "notary_patel", name: "Arjun Patel, Notary Public", schedule_ids: ["notary_office", "notary_online"] }
    ],
    services: [
      {
        id: "notary_document",
        name: "Document notarization",
        duration: "PT20M",
        price: money(1500, "USD"),
        branch: "happy path, in-person and online peer schedules",
        schedule_ids: ["notary_office", "notary_online"],
        policy: basePolicy({})
      },
      {
        id: "notary_loan_signing",
        name: "Loan signing",
        duration: "PT75M",
        price: money(17500, "USD"),
        branch: "happy path, in-person only",
        schedule_ids: ["notary_office"],
        policy: basePolicy({})
      },
      {
        id: "notary_identity_verification",
        name: "Identity verification required",
        duration: "PT15M",
        price: money(2500, "USD"),
        branch: "requires_verification runtime path",
        schedule_ids: ["notary_office", "notary_online"],
        policy: basePolicy({})
      },
      {
        id: "notary_apostille",
        name: "Apostille processing",
        duration: "PT30M",
        price: nonFixedMoney("USD", "quote_required"),
        branch: "requires_user_confirmation: quote_required price",
        schedule_ids: ["notary_office"],
        policy: basePolicy({})
      },
      {
        id: "notary_closing_package",
        name: "Closing package notarization",
        duration: "PT90M",
        price: money(25000, "USD"),
        branch: "requires_payment_handoff: deposit",
        schedule_ids: ["notary_office"],
        policy: basePolicy({ payment_requirement: "deposit", deposit: money(5000, "USD") })
      },
      {
        id: "notary_complex_document_review",
        name: "Complex document intake",
        duration: "PT30M",
        price: money(5000, "USD"),
        requires_consultation: true,
        branch: "requires_consultation_handoff",
        schedule_ids: ["notary_office"],
        policy: basePolicy({})
      },
      {
        id: "notary_custom_filing",
        name: "Custom filing appointment",
        duration: "PT30M",
        price: money(4000, "USD"),
        branch: "requires_user_confirmation: unknown payment",
        schedule_ids: ["notary_office"],
        policy: basePolicy({ payment_requirement: "unknown" })
      }
    ]
  },
  {
    id: "org_01jz7jevggr5st9acrxfbexvzz",
    name: "Andy's Auto",
    slug: "andys-auto",
    country: "DE",
    currency: "EUR",
    timezone: "Europe/Berlin",
    domain: "andys-auto.example",
    phone: "+49305550100",
    support_email: "service@andys-auto.example",
    locations: [
      {
        id: "auto_berlin_shop",
        name: "Kreuzberg Service Bay",
        slug: "kreuzberg-service-bay",
        address: "Prinzenstrasse 85, 10969 Berlin",
        timezone: "Europe/Berlin",
        latitude: 52.5034,
        longitude: 13.4105,
        hours: weekdayHours("08:00", "17:00")
      }
    ],
    providers: [
      { id: "auto_tech_anna", name: "Anna Fischer", schedule_ids: ["auto_berlin_shop"] },
      { id: "auto_tech_kai", name: "Kai Schneider", schedule_ids: ["auto_berlin_shop"] }
    ],
    services: [
      {
        id: "auto_oil_change",
        name: "Oil change (Ölwechsel)",
        duration: "PT45M",
        price: money(8900, "EUR"),
        branch: "happy path",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({ cancellation_fee: money(3000, "EUR") })
      },
      {
        id: "auto_tire_change",
        name: "Tire rotation and change",
        duration: "PT60M",
        price: money(12900, "EUR"),
        branch: "happy path",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({ cancellation_fee: money(3000, "EUR") })
      },
      {
        id: "auto_tuv_hu_inspection",
        name: "TÜV/HU vehicle inspection",
        duration: "PT60M",
        price: money(15900, "EUR"),
        branch: "happy path",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({ cancellation_fee: money(3000, "EUR") })
      },
      {
        id: "auto_brake_inspection",
        name: "Brake inspection",
        duration: "PT45M",
        price: money(6900, "EUR"),
        branch: "happy path",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({ cancellation_fee: money(3000, "EUR") })
      },
      {
        id: "auto_battery_replacement",
        name: "Battery replacement",
        duration: "PT45M",
        price: money(14900, "EUR"),
        branch: "happy path",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({ cancellation_fee: money(3000, "EUR") })
      },
      {
        id: "auto_ac_service",
        name: "AC service",
        duration: "PT60M",
        price: money(11900, "EUR"),
        branch: "happy path",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({ cancellation_fee: money(3000, "EUR") })
      },
      {
        id: "auto_check_engine_diagnosis",
        name: "Check-engine diagnosis",
        duration: "PT45M",
        price: money(9900, "EUR"),
        requires_consultation: true,
        branch: "requires_consultation_handoff",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({})
      },
      {
        id: "auto_major_repair",
        name: "Major repair intake",
        duration: "PT90M",
        price: money(50000, "EUR"),
        branch: "requires_payment_handoff: deposit",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({ payment_requirement: "deposit", deposit: money(10000, "EUR") })
      },
      {
        id: "auto_custom_repair_quote",
        name: "Custom repair estimate",
        duration: "PT45M",
        price: nonFixedMoney("EUR", "quote_required"),
        branch: "requires_user_confirmation: quote_required price",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({})
      },
      {
        id: "auto_special_order_part",
        name: "Special-order part appointment",
        duration: "PT30M",
        price: money(10000, "EUR"),
        branch: "requires_user_confirmation: unknown payment",
        schedule_ids: ["auto_berlin_shop"],
        policy: basePolicy({ payment_requirement: "unknown" })
      }
    ]
  },
  {
    id: "org_01jz731qszrrnysfpdypv1kkv7",
    name: "Phil's Spa",
    slug: "phils-spa",
    country: "GB",
    currency: "GBP",
    timezone: "Europe/London",
    domain: "phils-spa.example",
    phone: "+44205550100",
    support_email: "hello@phils-spa.example",
    locations: [
      {
        id: "spa_soho",
        name: "Soho Treatment Rooms",
        slug: "soho-treatment-rooms",
        address: "12 Greek St, London W1D 4DL",
        timezone: "Europe/London",
        latitude: 51.5135,
        longitude: -0.1307,
        hours: weekdayHours("10:00", "19:00")
      }
    ],
    providers: [
      { id: "spa_amelia", name: "Amelia Hart", schedule_ids: ["spa_soho"], has_portfolio: true },
      { id: "spa_oliver", name: "Oliver Grant", schedule_ids: ["spa_soho"] }
    ],
    services: [
      {
        id: "spa_swedish_massage",
        name: "Swedish massage",
        duration: "PT60M",
        price: money(9500, "GBP"),
        branch: "happy path",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({ no_show_fee: money(5000, "GBP") })
      },
      {
        id: "spa_deep_tissue_massage",
        name: "Deep-tissue massage",
        duration: "PT60M",
        price: money(11000, "GBP"),
        branch: "happy path",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({ no_show_fee: money(5000, "GBP") })
      },
      {
        id: "spa_hot_stone_massage",
        name: "Hot-stone massage",
        duration: "PT75M",
        price: money(13000, "GBP"),
        branch: "happy path",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({ no_show_fee: money(5000, "GBP") })
      },
      {
        id: "spa_aromatherapy_facial",
        name: "Aromatherapy facial",
        duration: "PT50M",
        price: money(8500, "GBP"),
        branch: "happy path",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({ no_show_fee: money(5000, "GBP") })
      },
      {
        id: "spa_body_wrap",
        name: "Body wrap",
        duration: "PT75M",
        price: money(12500, "GBP"),
        branch: "happy path",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({ no_show_fee: money(5000, "GBP") })
      },
      {
        id: "spa_sauna_steam",
        name: "Sauna and steam session",
        duration: "PT45M",
        price: money(4500, "GBP"),
        branch: "happy path",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({ no_show_fee: money(5000, "GBP") })
      },
      {
        id: "spa_gift_experience_jpy",
        name: "Japanese bathing gift experience",
        duration: "PT45M",
        price: money(12000, "JPY"),
        branch: "minor-unit exponent fixture: JPY has zero decimals",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({ no_show_fee: money(5000, "GBP") })
      },
      {
        id: "spa_couples_day_package",
        name: "Couples-massage day package",
        duration: "PT150M",
        price: money(32000, "GBP"),
        branch: "requires_payment_handoff: full_prepay",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({ payment_requirement: "full_prepay" })
      },
      {
        id: "spa_skin_consultation",
        name: "Skin consultation",
        duration: "PT30M",
        price: money(4500, "GBP"),
        requires_consultation: true,
        branch: "requires_consultation_handoff",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({})
      },
      {
        id: "spa_custom_wellness_package",
        name: "Custom wellness package",
        duration: "PT60M",
        price: nonFixedMoney("GBP", "quote_required"),
        branch: "requires_user_confirmation: quote_required price",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({})
      },
      {
        id: "spa_private_event",
        name: "Private event appointment",
        duration: "PT60M",
        price: money(10000, "GBP"),
        branch: "requires_user_confirmation: unknown payment",
        schedule_ids: ["spa_soho"],
        policy: basePolicy({ payment_requirement: "unknown" })
      }
    ]
  }
];
