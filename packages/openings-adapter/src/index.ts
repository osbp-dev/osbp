import type {
  AdapterResult,
  BookingApproval,
  AvailabilityFindInput,
  Booking,
  BookingStatus,
  BookingAdapter,
  BookingCreateInput,
  BookingMandate,
  BookingStatusInput,
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
  ServiceOption,
  Slot,
  UpstreamMeta,
  VerificationChallenge,
  VerificationSendInput,
  VerificationVerifyInput
} from "@osbp/core";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OSBP_VERSION, requireApproval, validateMandate } from "@osbp/core";

// Single source token, reused for the X-OSBP-Source header and the appointment
// metadata written on create. Keep these in sync by construction.
const OSBP_SOURCE = `openings-adapter/${OSBP_VERSION}`;

export interface OpeningsAdapterConfig {
  apiBaseUrl?: string;
  salonSlug?: string;
  salonId?: string;
  scheduleIds: string[];
  providerUserIds: string[];
  serviceIds: string[];
  enableCustomerFallback?: boolean;
  customerId?: string;
  customerPhone?: string;
  /** @deprecated Use enableCustomerFallback. */
  enableTestCustomerFallback?: boolean;
  /** @deprecated Use customerId. */
  testCustomerId?: string;
  /** @deprecated Use customerPhone. */
  testCustomerPhone?: string;
  sendNotifications?: boolean;
  httpTimeoutMs?: number;
  bearerToken?: string;
  apiKey?: string;
  openingsVersion?: string;
  idempotencyStorePath?: string;
}

export function loadOpeningsConfigFromEnv(
  env: Record<string, string | undefined>
): OpeningsAdapterConfig {
  const enableCustomerFallback =
    parseEnvBoolean(env.OPENINGS_ENABLE_CUSTOMER_FALLBACK) ??
    parseEnvBoolean(env.OPENINGS_ENABLE_TEST_CUSTOMER_FALLBACK) ??
    false;
  const customerId = envString(env.OPENINGS_CUSTOMER_ID) ?? envString(env.OPENINGS_TEST_CUSTOMER_ID);
  const customerPhone = envString(env.OPENINGS_CUSTOMER_PHONE) ?? envString(env.OPENINGS_TEST_CUSTOMER_PHONE);

  return {
    apiBaseUrl: envString(env.OPENINGS_API_BASE_URL),
    salonSlug: envString(env.OPENINGS_SALON_SLUG),
    salonId: envString(env.OPENINGS_SALON_ID),
    scheduleIds: splitEnvList(env.OPENINGS_SCHEDULE_IDS),
    providerUserIds: splitEnvList(env.OPENINGS_STAFF_USER_IDS),
    serviceIds: splitEnvList(env.OPENINGS_SERVICE_IDS),
    enableCustomerFallback,
    customerId,
    customerPhone,
    enableTestCustomerFallback: enableCustomerFallback,
    testCustomerId: customerId,
    testCustomerPhone: customerPhone,
    sendNotifications: parseEnvBoolean(env.OPENINGS_SEND_NOTIFICATIONS),
    httpTimeoutMs: parsePositiveInteger(env.OPENINGS_HTTP_TIMEOUT_MS),
    bearerToken: envString(env.OPENINGS_BEARER_TOKEN),
    apiKey: envString(env.OPENINGS_API_KEY),
    openingsVersion: envString(env.OPENINGS_VERSION) ?? envString(env.OPENINGS_API_VERSION),
    idempotencyStorePath: envString(env.OSBP_IDEMPOTENCY_STORE_PATH)
  };
}

// Repo root derived from this module at <repo>/packages/openings-adapter/dist/index.js,
// so loadOsbpEnv resolves the same files regardless of the caller's process.cwd().
const ADAPTER_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function parseEnvFile(path: string): Record<string, string> {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return {}; // a missing layer is fine; another layer (or process.env) may supply the keys
  }
  const env: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    env[key] = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

/**
 * Layered OSBP env loader. Reads the repo's local env files in increasing
 * precedence, so a single root `.env.local` can hold every adapter's secrets,
 * namespaced by prefix (OPENINGS_*, and future <ADAPTER>_*):
 *
 *   1. <repoRoot>/integrations/v0.1.0/openings/.env.local  (public integration fallback)
 *   2. <repoRoot>/.env.local                            (consolidated local file; WINS)
 *
 * Callers layer process.env on top, which wins over both:
 *   loadOpeningsConfigFromEnv({ ...loadOsbpEnv(repoRoot), ...process.env })
 *
 * A missing file contributes nothing. Third-party installs (no repo .env.local)
 * get `{}` and pass their own env to loadOpeningsConfigFromEnv as before.
 */
export function loadOsbpEnv(repoRoot: string = ADAPTER_REPO_ROOT): Record<string, string> {
  return {
    ...parseEnvFile(resolve(repoRoot, "integrations/v0.1.0/openings/.env.local")),
    ...parseEnvFile(resolve(repoRoot, ".env.local"))
  };
}

export class OpeningsAdapter implements BookingAdapter {
  private readonly idempotencyCache: Map<string, IdempotencyEntry>;
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  // Reserve idempotency keys for the duration of an in-flight createBooking, so
  // genuinely concurrent calls sharing a key await the first attempt instead of
  // each issuing their own booking POST. The completed-result cache above is
  // written only after the POST returns, so on its own it dedupes sequential
  // retries but not concurrent ones. Process-local and ephemeral; never written
  // to the on-disk store, which holds only settled results.
  private readonly inFlightBookings = new Map<string, InFlightBooking>();
  // Memoize the salon promise for the lifetime of the adapter instance.
  // Several methods (describeService, explainPolicy, listLocations,
  // findAvailability) all need the salon record; without this, a single
  // booking flow would do 3-4 redundant /v1/salons GETs against the same
  // configured salon. Cleared on failure so transient errors can retry.
  private salonPromise?: Promise<AdapterResult<OpeningsSalon>>;

  // Static identity of the booking platform this adapter speaks to, recorded
  // into audit events. Matches the Openings OpenAPI document (info.version
  // "1.0.0"). Openings sends an `Openings-Version` response header; the adapter
  // does not read it.
  readonly platform: PlatformIdentity = { vendor: "openings", api_version: "v1" };
  private lastUpstreamMeta: UpstreamMeta | undefined;
  private readonly lifecycleWarned = new Set<string>();

  get upstreamMeta(): UpstreamMeta | undefined {
    return this.lastUpstreamMeta;
  }

  constructor(readonly config: OpeningsAdapterConfig) {
    this.idempotencyCache = loadIdempotencyStore(config.idempotencyStorePath);
  }

  async resolveSalon(): Promise<AdapterResult<OpeningsSalon>> {
    if (this.salonPromise) {
      return this.salonPromise;
    }
    const promise = this.fetchSalon();
    this.salonPromise = promise;
    promise.then(
      (result) => {
        if (!result.ok) {
          this.salonPromise = undefined;
        }
      },
      () => {
        this.salonPromise = undefined;
      }
    );
    return promise;
  }

  private async fetchSalon(): Promise<AdapterResult<OpeningsSalon>> {
    if (!this.config.salonId && !this.config.salonSlug) {
      return missingConfig("OPENINGS_SALON_ID or OPENINGS_SALON_SLUG");
    }

    try {
      if (this.config.salonId) {
        return ok(mapSalon(await this.getJson<unknown>(`/v1/salons/${this.config.salonId}`), this.config.salonId));
      }

      const salonSlug = this.config.salonSlug;
      if (!salonSlug) {
        return missingConfig("OPENINGS_SALON_ID or OPENINGS_SALON_SLUG");
      }

      return ok(
        mapSalon(
          await this.getJson<unknown>("/v1/salons/by-slug", {
            slug: salonSlug
          }),
          this.config.salonId
        )
      );
    } catch (error) {
      return problemFromError("openings_organization_lookup_failed", error);
    }
  }

  async listLocations(): Promise<AdapterResult<LocationSchedule[]>> {
    const salon = await this.resolveSalon();
    if (!salon.ok) {
      return salon;
    }

    try {
      const response = await this.getJson<unknown>("/v1/locations", {
        salonId: salon.value.id
      });

      return ok(extractArray(response).map(mapLocationSchedule).filter(isPresent));
    } catch (error) {
      return problemFromError("openings_locations_failed", error);
    }
  }

  async listServices(): Promise<AdapterResult<Service[]>> {
    const salon = await this.resolveSalon();
    if (!salon.ok) {
      return salon;
    }

    try {
      const response = await this.getJson<unknown>("/v1/services", {
        salonId: salon.value.id
      });

      const currency = salon.value.currency;
      return ok(
        extractArray(response)
          .map((record) => mapService(record, currency))
          .filter(isPresent)
      );
    } catch (error) {
      return problemFromError("openings_services_failed", error);
    }
  }

  async describeService(input: ServiceDescribeInput): Promise<AdapterResult<Service>> {
    const serviceId = input.service_id ?? this.config.serviceIds[0];
    if (!serviceId) {
      return missingConfig("OPENINGS_SERVICE_IDS");
    }

    // Fetch the salon alongside the service so Service.price (a Money object
    // with currency and display) can be populated. Openings returns currency on
    // the salon record, not on individual services, so describeService alone
    // cannot build a Money without this extra GET.
    const salon = await this.resolveSalon();
    if (!salon.ok && salon.problem.code === "missing_config") {
      return salon;
    }
    const salonCurrency = salon.ok ? salon.value.currency : undefined;

    try {
      const service = mapService(
        await this.getJson<unknown>(`/v1/services/${serviceId}`),
        salonCurrency
      ) ?? {
        id: serviceId,
        name: "Unknown Openings service"
      };
      return ok(service);
    } catch (error) {
      return problemFromError("openings_service_failed", error);
    }
  }

  async findAvailability(input: AvailabilityFindInput): Promise<AdapterResult<Slot[]>> {
    const serviceId = input.service_id ?? this.config.serviceIds[0];
    const scheduleId = input.schedule_id ?? this.config.scheduleIds[0];

    if (!serviceId) {
      return missingConfig("OPENINGS_SERVICE_IDS or service_id");
    }
    if (!scheduleId) {
      return missingConfig("OPENINGS_SCHEDULE_IDS or schedule_id");
    }

    // Look up salon + locations up front so each Slot can carry human-readable
    // context (salon name, location title, street address) plus the canonical
    // organization_id needed to construct a booking.create mandate without round-tripping
    // through policy.explain. Salon currency powers Slot.price (amount_minor +
    // currency) so the agent can show a price without doing the conversion itself.
    const salon = await this.resolveSalon();
    if (!salon.ok && salon.problem.code === "missing_config") {
      return salon;
    }
    const salonId = salon.ok ? salon.value.id : undefined;
    const salonName = salon.ok ? (salon.value.name ?? salon.value.slug) : undefined;
    const salonCurrency = salon.ok ? salon.value.currency : undefined;
    const salonTimezone = salon.ok ? salon.value.timezone : undefined;
    const locations = await this.listLocations();
    const locationsById = new Map<string, LocationSchedule>();
    if (locations.ok) {
      for (const location of locations.value) {
        locationsById.set(location.id, location);
      }
    }

    try {
      const response = await this.getJson<unknown>("/v1/openings/members", {
        salonId: this.requireSalonId(),
        scheduleId,
        date: input.date,
        services: JSON.stringify([{ serviceId }])
      });

      return ok(extractSlots(response, {
        ...input,
        service_id: serviceId,
        schedule_id: scheduleId,
        organization_id: salonId,
        organization_name: salonName,
        organization_currency: salonCurrency,
        organization_timezone: salonTimezone,
        locations_by_id: locationsById
      }));
    } catch (error) {
      return problemFromError("openings_availability_failed", error);
    }
  }

  async explainPolicy(input: PolicyExplainInput): Promise<AdapterResult<Policy>> {
    const serviceId = input.service_id ?? this.config.serviceIds[0];
    if (!serviceId) {
      return missingConfig("OPENINGS_SERVICE_IDS");
    }

    const salon = await this.resolveSalon();
    if (!salon.ok) {
      return salon;
    }

    try {
      const service = await this.getJson<unknown>(`/v1/services/${serviceId}`);
      return ok(mapPolicy(salon.value, asRecord(service), serviceId));
    } catch (error) {
      return problemFromError("openings_policy_failed", error);
    }
  }

  async sendVerification(input: VerificationSendInput): Promise<AdapterResult<VerificationChallenge>> {
    const customer = input.customer ?? {};
    const phone = customer.phone ?? (customer.email ? undefined : this.customerPhoneFallback());

    let purpose: AdapterResult<string>;
    try {
      // requireSalonId throws when OPENINGS_SALON_ID is unset; keep it mapped
      // into the adapter result path, never a rejected promise.
      purpose = requireBookingVerificationPurpose(input.purpose, this.requireSalonId());
    } catch (error) {
      return problemFromError("openings_verification_send_failed", error);
    }
    if (!purpose.ok) return purpose;

    if (!phone && !customer.email) {
      return missingConfig("customer.phone, customer.email, or OPENINGS_ENABLE_CUSTOMER_FALLBACK=true with OPENINGS_CUSTOMER_PHONE");
    }

    try {
      // Openings expects phoneNumber / email at the top level of the body, not
      // nested under a "customer" key. For cancel purposes the phone is resolved
      // from the appointment so the field is optional; for booking purposes it is
      // required (there is no appointment to look it up from). Passing it flat
      // satisfies both cases.
      await this.postJson<unknown>("/v1/verifications/send", {
        phoneNumber: phone,
        email: customer.email,
        purpose: purpose.value
      });

      return ok({
        sent: true,
        method: phone ? "sms" : "email",
        purpose: purpose.value
      });
    } catch (error) {
      return problemFromError("openings_verification_send_failed", error);
    }
  }

  async verifyCode(input: VerificationVerifyInput): Promise<AdapterResult<VerificationChallenge>> {
    return unsupportedOpeningsVerify(input.purpose);
  }

  async createBooking(input: BookingCreateInput): Promise<AdapterResult<Receipt>> {
    const normalizedInput = normalizeBookingCreateInput(input);
    if (!normalizedInput.ok) return normalizedInput;
    input = normalizedInput.value;

    const payloadHash = stableHash(redactTransientCreateFields(input));
    const cached = this.idempotencyCache.get(input.idempotency_key);
    if (cached) {
      return cached.payloadHash === payloadHash ? localCacheReplay(cached.result) : idempotencyConflict();
    }

    // Reserve the key before the network call. No await separates the cache
    // miss above from this registration, so a second genuinely concurrent call
    // with the same key observes the in-flight entry and awaits the first
    // attempt instead of issuing its own POST. Payload-hash semantics match the
    // completed cache: a different payload still conflicts, and because the hash
    // excludes verification_code, a verification retry shares the same attempt.
    const inFlight = this.inFlightBookings.get(input.idempotency_key);
    if (inFlight) {
      return inFlight.payloadHash === payloadHash ? inFlight.promise : idempotencyConflict();
    }

    const attempt = this.performBooking(input, payloadHash);
    this.inFlightBookings.set(input.idempotency_key, { payloadHash, promise: attempt });
    return attempt;
  }

  // Resolve a customer ID for booking. Preference order:
  // 1. Explicit id on the input, or the configured fallback only when the input
  //    carries no contact.
  // 2. POST /v1/customers/booking (create-or-find, idempotent on salonId+phone/email).
  // 3. History probe fallback (returns a customer id).
  private async resolveCustomerId(
    customer: BookingCreateInput["customer"]
  ): Promise<AdapterResult<string>> {
    const email = customer?.email;
    const hasExplicitContact = Boolean(customer?.phone || email);
    const explicit = customer?.id ?? (hasExplicitContact ? undefined : this.customerIdFallback());
    if (explicit) return ok(explicit);

    // The configured phone is a fallback for inputs that carry no contact at
    // all. Never blend it with an explicit email: /v1/customers/booking is
    // idempotent on (salonId, phoneNumber|email), so a fallback phone sent
    // beside the input's email can resolve a different customer than the one
    // the input identifies, and the appointment would be created for the
    // wrong customerId.
    const phone = customer?.phone ?? (email ? undefined : this.customerPhoneFallback());
    if (!phone && !email) {
      return missingConfig("customer.id, customer.phone, customer.email, or OPENINGS_ENABLE_CUSTOMER_FALLBACK=true with OPENINGS_CUSTOMER_ID/OPENINGS_CUSTOMER_PHONE");
    }

    const salonId = this.requireSalonId();
    const userId = this.config.providerUserIds[0];
    let customerBookingFailure: AdapterResult<string> | undefined;

    if (userId) {
      const name = customerNameParts(customer);
      if (!name) {
        return missingConfig("customer.given_name and customer.family_name, or a display_name with first and last name");
      }

      try {
        // Openings requires firstName and lastName even for existing-customer
        // lookups. Do not invent those values: many names are not safely
        // splittable (for example Chinese names without spaces), and these
        // fields may be written into the merchant CRM.
        const response = await this.postJson<unknown>("/v1/customers/booking", {
          salonId,
          userId,
          phoneNumber: phone,
          email,
          firstName: name.firstName,
          lastName: name.lastName
        });
        const record = unwrapRecord(response as unknown as JsonRecord, ["data"]);
        const customerId = stringField(record, "customerId");
        if (customerId) return ok(customerId);
      } catch (error) {
        customerBookingFailure = problemFromError("openings_customer_booking_failed", error);
        if (!phone) return customerBookingFailure;
        // Fall through to history probe. If the probe also fails, the catch
        // below prefers this failure over the probe's; if the probe succeeds,
        // this failure is discarded but not silent: requestJson already wrote
        // it to stderr as `upstream_error ...` at the throw site above.
      }
    }

    if (!phone) {
      return customerBookingFailure ?? missingConfig("OPENINGS_STAFF_USER_IDS, customer.id, or OPENINGS_ENABLE_CUSTOMER_FALLBACK=true with OPENINGS_CUSTOMER_ID");
    }

    try {
      const response = await this.getJson<HistoryProbeResponse>(
        `/v1/appointments/history/${encodeURIComponent(phone)}`,
        { salonId }
      );
      const probe = unwrapRecord(response as unknown as JsonRecord, ["data"]);
      const customerId = stringField(probe, "customerId");
      if (customerId) return ok(customerId);
      return customerBookingFailure ?? missingConfig("customer.given_name and customer.family_name, or a display_name with first and last name");
    } catch (error) {
      return customerBookingFailure ?? problemFromError("openings_customer_history_failed", error);
    }
  }

  private async performBooking(
    input: BookingCreateInput,
    payloadHash: string
  ): Promise<AdapterResult<Receipt>> {
    try {
      const service = await this.describeService({ service_id: input.service_id });
      if (!service.ok) {
        return service;
      }

      const policy = await this.explainPolicy({ service_id: input.service_id });
      if (!policy.ok) {
        return policy;
      }

      // Internal slot used only to drive validateMandate, which compares the
      // wall-clock window against the mandate. The absolute instant is not
      // needed here (the validator does not read it for the window check), but
      // ends_at_local is: without it the validator falls back to the start time
      // for the latest_end check, letting a booking that starts inside the
      // mandate window but runs past latest_end slip through. Derive the end
      // from the service duration; if the duration is unparseable, leave it
      // undefined and the validator falls back as before (never over-rejects).
      const startsAtLocal = `${input.date}T${input.time.length === 5 ? `${input.time}:00` : input.time}`;
      const durationMinutes = iso8601DurationToMinutes(service.value.duration);
      const slot: Slot = {
        id: [input.schedule_id, input.provider_id, input.service_id, input.date, input.time].join(":"),
        schedule_id: input.schedule_id,
        provider_id: input.provider_id,
        service_id: input.service_id,
        starts_at_local: startsAtLocal,
        ends_at_local: durationMinutes !== undefined ? addMinutesToWallClock(startsAtLocal, durationMinutes) : undefined,
        price: service.value.price
      };

      const mandateValidation = validateMandate({
        mandate: input.mandate,
        action: "booking.create",
        organization_id: this.requireSalonId(),
        service: service.value,
        slot,
        policy: policy.value
      });
      if (!mandateValidation.ok) {
        return {
          ok: false,
          problem: mandateValidation.problem
        };
      }

      // Adapter-side confirmation lives after mandate validation and before
      // any upstream customer resolution or appointment write. The point is to
      // force the resolved service, merchant-local time, price, and policy into
      // a user-visible summary, so the concrete booking is understood and
      // authorized by the user before Openings sees a create mutation. The token is
      // agent-visible, so this is a v0.1.0 brake until host/server-side human
      // approval can enforce the same boundary out of band.
      const approval = this.requireApproval(input, payloadHash, service.value, slot, policy.value);
      if (!approval.ok) return approval;

      const customerIdResult = await this.resolveCustomerId(input.customer);
      if (!customerIdResult.ok) return customerIdResult;
      const customerId = customerIdResult.value;

      try {
        // Do NOT send requestId here. On Openings, /v1/appointments/create
        // treats requestId as the foreign key to a ServiceRequest record (the
        // consultation/quote workflow's entity), not as an idempotency key.
        // Sending OSBP's idempotency_key as requestId triggers a
        // `prisma.serviceRequest.findUnique` that returns null, producing a
        // 404 "Service request not found" before the booking is even attempted.
        // OSBP idempotency stays purely local via this.idempotencyCache above.
        const response = await this.postJson<unknown>(
          "/v1/appointments/create",
          {
            salonId: this.requireSalonId(),
            userId: input.provider_id,
            scheduleId: input.schedule_id,
            customerId,
            date: input.date,
            time: input.time,
            services: [{ id: input.service_id }],
            verificationCode: input.verification_code,
            sendNotifications: this.config.sendNotifications,
            metadata: buildAppointmentMetadata(input)
          }
        );

        const booking = mapBooking(response, input, customerId, policy.value.organization?.timezone);
        const result = ok<Receipt>({
          id: `receipt_${input.idempotency_key}`,
          booking_id: booking.id,
          text: `Booked ${service.value.name} on ${input.date} at ${input.time}. Openings appointment id: ${booking.id}.`
        });
        this.rememberIdempotentResult(input.idempotency_key, {
          payloadHash,
          result,
          booking
        });
        this.pendingApprovals.delete(payloadHash);

        return result;
      } catch (error) {
        const mapped = problemFromCreateError(error);
        if (mapped) return mapped;

        return problemFromError("openings_booking_create_failed", error);
      }
    } catch (error) {
      // The adapter contract requires every failure to be an AdapterResult,
      // never a thrown rejection (callers like runReadOnlySmoke and the audit
      // wrapper rely on this). The inner try maps upstream HTTP errors; this
      // outer catch covers the prelude: a requireSalonId throw when
      // OPENINGS_SALON_ID is unset, or any unforeseen throw before the POST.
      return problemFromError("openings_booking_create_failed", error);
    } finally {
      // Free the reservation once the attempt settles. On success the
      // completed-result cache (written above) takes over dedupe for later
      // sequential retries; on failure nothing was cached, so a later retry is
      // allowed to start a fresh attempt.
      this.inFlightBookings.delete(input.idempotency_key);
    }
  }

  async getBooking(input: BookingStatusInput): Promise<AdapterResult<Booking>> {
    const cachedBooking = [...this.idempotencyCache.values()]
      .map((entry) => entry.booking)
      .find((booking) => booking.id === input.booking_id);
    if (cachedBooking) {
      return ok(cachedBooking);
    }

    // Direct readback by id via Openings' public
    // `GET /v1/appointments/{id}/review`, an id-as-capability confirmation read:
    // no salon auth, no verification step, and a non-existent id returns
    // "Appointment not found" rather than an auth challenge. Used for any
    // booking id not in the local idempotency cache, including bookings OSBP
    // did not create. The history probe below runs only when no booking id is
    // given.
    if (input.booking_id) {
      try {
        const response = await this.getJson<unknown>(
          `/v1/appointments/${encodeURIComponent(input.booking_id)}/review`
        );
        return ok(mapReviewBooking(response, input.booking_id));
      } catch (error) {
        if (error instanceof OpeningsHttpError && error.status === 404) {
          return {
            ok: false,
            problem: {
              code: "booking_not_found",
              message: "Openings has no appointment with the supplied booking id",
              retryable: false
            }
          };
        }
        return problemFromError("openings_booking_status_failed", error);
      }
    }

    const email = input.customer?.email;
    const phone = input.customer?.phone ?? (email ? undefined : this.customerPhoneFallback());

    if (!phone && !email) {
      return missingConfig("customer.phone, customer.email, or OPENINGS_ENABLE_CUSTOMER_FALLBACK=true with OPENINGS_CUSTOMER_PHONE");
    }

    try {
      // The history endpoint requires an interactive verification step that
      // OSBP v0.1.0 read tools cannot complete, so only a minimal
      // "has upcoming appointments" signal is observable here, not the full
      // appointment payload (no ids, no times, no prices). The spec requires
      // failing closed on an unknown verification state (see the spec
      // Security and Privacy Considerations and Adapter Contract;
      // booking.status is a read path), so this adapter treats that minimal
      // signal as the only available read until the protocol grows a
      // verification-bearing read flow.
      const response = phone
        ? await this.getJson<HistoryProbeResponse>(`/v1/appointments/history/${encodeURIComponent(phone)}`, {
          salonId: this.requireSalonId()
        })
        : await this.getJson<HistoryProbeResponse>("/v1/appointments/history/by-email", {
          email: email ?? "",
          salonId: this.requireSalonId()
        });

      const probe = unwrapRecord(response, ["data"]);
      const hasUpcomingAppointments = booleanField(probe, "hasUpcomingAppointments") === true;

      if (!hasUpcomingAppointments) {
        return {
          ok: false,
          problem: {
            code: "booking_not_found",
            message: "Openings reports no upcoming appointments for the supplied customer",
            retryable: false
          }
        };
      }

      // The probe reports whether upcoming appointments exist, without ids,
      // times, or the customer id. OSBP treats the platform as the system of
      // record (see the spec Security and Privacy Considerations) rather than
      // constructing booking truth locally, so this returns a problem and
      // points the caller at the snapshot from `booking.create`.
      return {
        ok: false,
        problem: {
          code: "booking_status_requires_verification",
          message:
            "Appointment status for this booking is not available to OSBP v0.1.0 read tools; " +
            "rely on the receipt returned by booking.create or hand off to the customer for status",
          retryable: false
        }
      };
    } catch (error) {
      return problemFromError("openings_booking_status_failed", error);
    }
  }

  private requireApproval(
    input: BookingCreateInput,
    payloadHash: string,
    service: Service,
    slot: Slot,
    policy: Policy
  ): AdapterResult<BookingApproval> {
    const approvalGate = requireApproval({
      approval: input.approval,
      payloadHash,
      summary: bookingApprovalSummary(input, service, slot, policy),
      store: this.pendingApprovals,
      now: Date.now(),
      newToken: randomUUID
    });
    return approvalGate.ok ? ok(approvalGate.approval) : approvalGate;
  }

  private requireSalonId(): string {
    if (!this.config.salonId) {
      throw new OpeningsError("OPENINGS_SALON_ID is required for this operation");
    }

    return this.config.salonId;
  }

  private customerIdFallback(): string | undefined {
    return this.customerFallbackEnabled() ? this.config.customerId ?? this.config.testCustomerId : undefined;
  }

  private customerPhoneFallback(): string | undefined {
    return this.customerFallbackEnabled() ? this.config.customerPhone ?? this.config.testCustomerPhone : undefined;
  }

  private customerFallbackEnabled(): boolean {
    return this.config.enableCustomerFallback ?? this.config.enableTestCustomerFallback ?? false;
  }

  private async getJson<T>(path: string, query: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, withTrailingSlash(this.requireApiBaseUrl()));
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    return this.requestJson<T>(url, {
      method: "GET"
    });
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    const url = new URL(path, withTrailingSlash(this.requireApiBaseUrl()));
    return this.requestJson<T>(url, {
      method: "POST",
      body: JSON.stringify(dropUndefined(body)),
      headers
    });
  }

  private async requestJson<T>(url: URL, init: RequestInit): Promise<T> {
    // Identity headers sent on every Openings API request.
    // User-Agent stacks three RFC 9110 product tokens:
    //   OSBP/{ver}                — protocol version (from @osbp/core OSBP_VERSION)
    //   openings-adapter/{ver}    — which adapter is calling; distinguishes adapters in Openings logs
    //   node/{major}              — Node.js major only; enough for runtime debugging without fingerprinting
    // X-OSBP-Source mirrors the adapter token for structured log filtering without UA parsing.
    // No URL appended: OSBP is a library; the deployer — not osbp.dev — is responsible for requests.
    // See AGENTS.md "HTTP Adapter Identity" for the full convention and debugging workflow.
    const controller = this.config.httpTimeoutMs ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => controller.abort(), this.config.httpTimeoutMs)
      : undefined;

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: controller?.signal ?? init.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": `OSBP/${OSBP_VERSION} openings-adapter/${OSBP_VERSION} node/${process.versions.node.split(".")[0]}`,
          "x-osbp-source": OSBP_SOURCE,
          ...this.openingsRequestHeaders(),
          ...init.headers
        }
      });
    } catch (error) {
      if (controller?.signal.aborted) {
        throw new OpeningsError(`Openings request timed out after ${this.config.httpTimeoutMs}ms`);
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }

    const meta = captureUpstreamMeta(
      `${(init.method ?? "GET").toUpperCase()} ${redactPathSegments(url.pathname)}`,
      response
    );
    this.lastUpstreamMeta = meta;
    this.warnOnLifecycleHeaders(meta);

    if (!response.ok) {
      const body = await response.text();
      const redactedPath = redactPathSegments(url.pathname);
      // Operator-only diagnostics. The full body can echo customer contact, so
      // it goes to stderr exclusively: never stdout, the Problem message, or the
      // audit log. 4xx bodies carry validation/business detail (e.g. 422
      // validation, 428 verification) that is no longer surfaced through
      // Problem.message, so they are logged here too for operator debugging.
      console.error(
        `[openings-adapter] upstream_error ${response.status} ${redactedPath} ${redactDiagnosticText(body).slice(0, 240)}`
      );
      throw new OpeningsHttpError(response.status, response.statusText, redactedPath, body);
    }

    return (await response.json()) as T;
  }

  private requireApiBaseUrl(): string {
    const apiBaseUrl = this.config.apiBaseUrl?.trim();
    if (!apiBaseUrl) {
      throw new OpeningsMissingConfigError("OPENINGS_API_BASE_URL");
    }

    return apiBaseUrl;
  }

  private openingsRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.bearerToken) {
      headers.authorization = `Bearer ${this.config.bearerToken}`;
    }
    if (this.config.apiKey) {
      headers["x-api-key"] = this.config.apiKey;
    }
    if (this.config.openingsVersion) {
      headers["openings-version"] = this.config.openingsVersion;
    }
    return headers;
  }

  // RFC 9745 (Deprecation) and RFC 8594 (Sunset) announce that an upstream
  // endpoint is going away. The call itself succeeded, so this is operator
  // observability: never a Problem, never agent-facing output. stderr, not
  // stdout, because stdout is the MCP transport channel. Deduped per endpoint
  // per process.
  private warnOnLifecycleHeaders(meta: UpstreamMeta): void {
    if (!meta.deprecation && !meta.sunset) {
      return;
    }
    if (this.lifecycleWarned.has(meta.call)) {
      return;
    }
    this.lifecycleWarned.add(meta.call);

    const parts = [`[openings-adapter] upstream_lifecycle_warning ${meta.call}`];
    if (meta.deprecation) {
      parts.push(`deprecation=${JSON.stringify(meta.deprecation)}`);
    }
    if (meta.sunset) {
      parts.push(`sunset=${JSON.stringify(meta.sunset)}`);
    }
    parts.push("upstream announced deprecation or sunset; revalidate this adapter before the date");
    console.error(parts.join(" "));
  }

  private rememberIdempotentResult(key: string, entry: IdempotencyEntry): void {
    this.idempotencyCache.set(key, entry);
    try {
      saveIdempotencyStore(this.config.idempotencyStorePath, this.idempotencyCache);
    } catch (error) {
      console.warn(
        `[openings-adapter] idempotency persistence failed; same-process replay remains available (${idempotencyPersistenceFailureReason(error)})`
      );
    }
  }
}

export interface ReadOnlySmokeResult {
  organization: OpeningsSalon;
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
  ok: true;
  message: string;
}

export async function runReadOnlySmoke(adapter: OpeningsAdapter): Promise<AdapterResult<ReadOnlySmokeResult>> {
  const salon = await adapter.resolveSalon();
  if (!salon.ok) {
    return salon;
  }

  const locations = await adapter.listLocations();
  if (!locations.ok) {
    return locations;
  }

  const services = await adapter.listServices();
  if (!services.ok) {
    return services;
  }

  const serviceId = adapter.config.serviceIds[0] ?? services.value[0]?.id;
  const scheduleId = adapter.config.scheduleIds[0] ?? locations.value[0]?.id;
  if (!serviceId || !scheduleId) {
    return {
      ok: false,
      problem: {
        code: "missing_smoke_target",
        message: "Read-only smoke needs at least one service id and one schedule id",
        retryable: false
      }
    };
  }

  const service = await adapter.describeService({ service_id: serviceId });
  if (!service.ok) {
    return service;
  }

  const policy = await adapter.explainPolicy({ service_id: serviceId });
  if (!policy.ok) {
    return policy;
  }

  const mandateReachability = checkMandateReachability(service.value, policy.value);
  if (!mandateReachability.ok) {
    return mandateReachability;
  }

  const bookableTarget = checkHappyPathTargetSupported(service.value, policy.value);
  if (!bookableTarget.ok) {
    return bookableTarget;
  }

  const policyShape = checkPolicyOrganizationCanaryShape(policy.value);
  if (!policyShape.ok) {
    return policyShape;
  }

  let availabilityDate = nextDateIso(1);
  let slots: AdapterResult<Slot[]> = ok([]);
  for (let offset = 1; offset <= 14; offset += 1) {
    availabilityDate = nextDateIso(offset);
    slots = await adapter.findAvailability({
      service_id: serviceId,
      schedule_id: scheduleId,
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
    const slotShape = checkAvailabilitySlotCanaryShape(slots.value[0]);
    if (!slotShape.ok) {
      return slotShape;
    }
  }

  const bookability = checkHappyPathBookability({
    salon: salon.value,
    service: service.value,
    policy: policy.value,
    slots: slots.value
  });
  if (!bookability.ok) {
    return bookability;
  }

  return ok({
    organization: salon.value,
    locations: locations.value,
    services: services.value,
    service: service.value,
    policy: policy.value,
    availabilityDate,
    slots: slots.value,
    checks: {
      mandate_reachability: mandateReachability.value,
      happy_path_bookability: bookability.value
    }
  });
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
    return {
      ok: false,
      problem: {
        code: "missing_mandate_reachability",
        message:
          "Read-only smoke cannot construct BookingMandate scope from service.describe + policy.explain; " +
          `missing ${missing.join(", ")}`,
        retryable: false
      }
    };
  }

  return ok({
    ok: true,
    message: "service.describe + policy.explain expose the read-tool fields needed to construct BookingMandate scope"
  });
}

function checkHappyPathTargetSupported(service: Service, policy: Policy): AdapterResult<SmokeCheck> {
  if (service.requires_consultation === true) {
    return {
      ok: false,
      problem: {
        code: "unsupported_smoke_bookability_target",
        message:
          "Happy-path smoke requires a v0.1.0-bookable service, but the configured service has requires_consultation=true; " +
          "choose a non-consultation smoke target instead of treating this as a mandate reachability failure",
        retryable: false
      }
    };
  }

  if (policy.payment_requirement && policy.payment_requirement !== "none") {
    return {
      ok: false,
      problem: {
        code: "unsupported_smoke_bookability_target",
        message:
          `Happy-path smoke requires a no-payment v0.1.0 target, but policy.explain returned payment_requirement=${policy.payment_requirement}; ` +
          "choose a no-payment smoke target instead of treating this as a mandate reachability failure",
        retryable: false
      }
    };
  }

  return ok({
    ok: true,
    message: "configured service is eligible for the v0.1.0 happy-path bookability smoke"
  });
}

function checkPolicyOrganizationCanaryShape(policy: Policy): AdapterResult<SmokeCheck> {
  const failures: string[] = [];

  requireNonEmptyString(failures, "Policy.service_id", policy.service_id);
  requireEnumString(failures, "Policy.payment_requirement", policy.payment_requirement, ["none", "deposit", "full_prepay", "unknown"]);
  requireEnumString(failures, "Policy.verification_method", policy.verification_method, ["sms", "email", "none", "unknown"]);

  if (!isRecord(policy.organization)) {
    failures.push(`Policy.organization expected object, got ${describeShape(policy.organization)}`);
  } else {
    requireNonEmptyString(failures, "Policy.organization.id", policy.organization.id);
    requireNonEmptyString(failures, "Policy.organization.name", policy.organization.name);
    requireNonEmptyString(failures, "Policy.organization.timezone", policy.organization.timezone);
    requireNonEmptyString(failures, "Policy.organization.currency", policy.organization.currency);
    requireNonEmptyString(failures, "Policy.organization.country", policy.organization.country);
  }

  return smokeShapeCheck("policy.explain organization canary", failures);
}

function checkAvailabilitySlotCanaryShape(slot: Slot): AdapterResult<SmokeCheck> {
  const failures: string[] = [];

  requireNonEmptyString(failures, "Slot.id", slot.id);
  requireNonEmptyString(failures, "Slot.organization_id", slot.organization_id);
  requireNonEmptyString(failures, "Slot.schedule_id", slot.schedule_id);
  requireNonEmptyString(failures, "Slot.service_id", slot.service_id);
  requireNonEmptyString(failures, "Slot.provider_id", slot.provider_id);
  requireNonEmptyString(failures, "Slot.starts_at_local", slot.starts_at_local);
  requireNonEmptyString(failures, "Slot.schedule_timezone", slot.schedule_timezone);
  // When the schedule tz is known, the adapter must also emit the canonical
  // absolute instant, and it must be a parseable RFC 3339 instant (carrying an
  // offset). Guards against a regression where the instant goes missing or is
  // emitted as a naked wall-clock string.
  if (slot.schedule_timezone) {
    requireInstant(failures, "Slot.starts_at", slot.starts_at);
  }
  requireFiniteNumber(failures, "Slot.price.amount_minor", slot.price?.amount_minor);
  requireNonEmptyString(failures, "Slot.price.currency", slot.price?.currency);

  return smokeShapeCheck("availability.find Slot canary", failures);
}

function smokeShapeCheck(label: string, failures: string[]): AdapterResult<SmokeCheck> {
  if (failures.length > 0) {
    return {
      ok: false,
      problem: {
        code: "smoke_shape_drift",
        message: `Read-only smoke canary response shape drift in ${label}: ${failures.join("; ")}`,
        retryable: false
      }
    };
  }

  return ok({
    ok: true,
    message: `${label} matches required smoke canary shape`
  });
}

function requireNonEmptyString(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${path} expected non-empty string, got ${describeShape(value)}`);
  }
}

function requireEnumString(
  failures: string[],
  path: string,
  value: unknown,
  allowedValues: readonly string[]
): void {
  if (typeof value !== "string" || !allowedValues.includes(value)) {
    failures.push(`${path} expected one of ${allowedValues.join("|")}, got ${describeShape(value)}`);
  }
}

function requireFiniteNumber(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failures.push(`${path} expected finite number, got ${describeShape(value)}`);
  }
}

// An absolute instant must be a non-empty string, parse as a real moment, and
// carry an explicit RFC 3339 offset (trailing `Z` or `±HH:MM` / `±HHMM`). A
// naked wall-clock string would parse but is the exact category error this
// refactor's instant fields must not regress into.
function requireInstant(failures: string[], path: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${path} expected non-empty instant string, got ${describeShape(value)}`);
    return;
  }
  const hasOffset = /Z$/i.test(value) || /[+-]\d{2}:?\d{2}$/.test(value);
  if (!hasOffset || !Number.isFinite(Date.parse(value))) {
    failures.push(`${path} expected RFC 3339 instant with an explicit offset, got ${JSON.stringify(value)}`);
  }
}

function describeShape(value: unknown): string {
  if (value === undefined) {
    return "missing";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === "") {
    return "empty string";
  }

  return typeof value;
}

function checkHappyPathBookability(input: {
  salon: OpeningsSalon;
  service: Service;
  policy: Policy;
  slots: Slot[];
}): AdapterResult<SmokeCheck> {
  if (input.slots.length === 0) {
    return {
      ok: false,
      problem: {
        code: "missing_smoke_bookability_slots",
        message: "Happy-path smoke found no slots for the configured v0.1.0-bookable service in the 14-day search window",
        retryable: false
      }
    };
  }

  for (const slot of input.slots) {
    const missing = missingBookabilitySlotFields(slot);
    if (missing.length > 0) {
      return {
        ok: false,
        problem: {
          code: "smoke_bookability_validation_failed",
          message: `Happy-path smoke slot ${slot.id} is missing booking-ready fields: ${missing.join(", ")}`,
          retryable: false
        }
      };
    }

    const mandate = buildSmokeMandate(input.salon, input.service, slot);
    const validation = validateMandate({
      mandate,
      action: "booking.create",
      organization_id: mandate.organization_id,
      service: input.service,
      slot,
      policy: input.policy
    });

    if (!validation.ok) {
      return {
        ok: false,
        problem: {
          code: "smoke_bookability_validation_failed",
          message:
            `Happy-path smoke slot ${slot.id} failed validateMandate with ${validation.problem.code}: ` +
            validation.problem.message,
          retryable: false
        }
      };
    }
  }

  return ok({
    ok: true,
    message: `validated ${input.slots.length} slot(s) against a constructed v0.1.0 BookingMandate`
  });
}

function missingBookabilitySlotFields(slot: Slot): string[] {
  const missing: string[] = [];

  if (!slot.organization_id) {
    missing.push("Slot.organization_id");
  }
  if (!slot.service_id) {
    missing.push("Slot.service_id");
  }
  if (!slot.schedule_id) {
    missing.push("Slot.schedule_id");
  }
  if (!slot.provider_id) {
    missing.push("Slot.provider_id");
  }
  if (!slot.starts_at_local) {
    missing.push("Slot.starts_at_local");
  }
  if (!slot.schedule_timezone) {
    missing.push("Slot.schedule_timezone");
  }

  return missing;
}

function buildSmokeMandate(salon: OpeningsSalon, service: Service, slot: Slot): BookingMandate {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  // Derive the cap from the higher of the slot/service price so a constructed
  // mandate bounds the live price exactly. Currency must match the price's
  // currency, or the validator's cross-currency guard fails the smoke closed.
  const priceAmounts = [service.price?.amount_minor, slot.price?.amount_minor]
    .filter((value): value is number => value !== undefined);
  const capAmount = priceAmounts.length > 0 ? Math.max(...priceAmounts) : undefined;
  const capCurrency = slot.price?.currency ?? service.price?.currency ?? salon.currency;
  const maxPrice: Money | undefined =
    capAmount !== undefined && capCurrency
      ? { amount_minor: capAmount, currency: capCurrency }
      : undefined;

  return {
    id: "smoke_read_only_mandate",
    expires_at: expiresAt,
    allowed_actions: ["booking.create"],
    organization_id: slot.organization_id ?? salon.id,
    service_ids: [service.id],
    provider_ids: slot.provider_id ? [slot.provider_id] : undefined,
    schedule_ids: [slot.schedule_id],
    // earliest_start / latest_end are wall-clock by contract, so derive them
    // from the slot's wall-clock fields, not the absolute instant. Do not
    // synthesize latest_end from starts_at_local: validateMandate correctly
    // fails closed when a latest_end cap exists without slot end evidence.
    earliest_start: slot.starts_at_local,
    latest_end: slot.ends_at_local,
    max_price: maxPrice,
    allow_policy_fee: false,
    max_extra_fee: capCurrency ? { amount_minor: 0, currency: capCurrency } : undefined
  };
}

export interface OpeningsSalon {
  id: string;
  name?: string;
  slug?: string;
  domain?: string;
  phoneNumber?: string;
  supportEmail?: string;
  instagramHandle?: string;
  timezone?: string;
  currency?: string;
  country?: string;
  totalLocations?: number;
  cancellationPolicyNote?: string;
  cancellationPolicyEnabled?: boolean;
  cancellationPolicyHours?: number;
  lateGraceMinutes?: number;
  verificationMethod?: string;
}

type JsonRecord = Record<string, unknown>;

// Minimal response the adapter models for the history endpoint when no
// interactive verification step has been completed: only whether the
// customer has upcoming appointments, plus an opaque customer id. The
// richer appointment payload is not available to OSBP v0.1.0 read tools.
interface HistoryProbeResponse {
  hasUpcomingAppointments?: boolean;
  customerId?: string | null;
  data?: { hasUpcomingAppointments?: boolean; customerId?: string | null };
}

class OpeningsError extends Error {
  override name = "OpeningsError";
}

class OpeningsMissingConfigError extends OpeningsError {
  constructor(readonly setting: string) {
    super(`${setting} is required`);
  }
}

class OpeningsHttpError extends OpeningsError {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly path: string,
    readonly body: string
  ) {
    // `path` arrives already contact-redacted (see requestJson). The raw `body`
    // is deliberately kept OUT of the Error message: problemFromError copies
    // this message into Problem.message, which reaches both the agent's context
    // and the audit log, and an upstream body can echo a phone, email, or
    // verification code. `body` stays a field for status mapping (isSlotConflict)
    // and is logged to stderr at the throw site for operators.
    super(`Openings ${status} ${statusText} for ${path}`);
  }
}

// Capture the per-call response metadata set an OSBP adapter records for the
// audit channel: Server (infrastructure fingerprint), the first request-id
// header, any response-side API version echo, Deprecation (RFC 9745), Sunset
// (RFC 8594), and RateLimit headers. Pure; no I/O.
export function captureUpstreamMeta(call: string, response: Response): UpstreamMeta {
  const meta: UpstreamMeta = { call, status: response.status };

  const server = response.headers.get("server");
  if (server) {
    meta.server = server;
  }
  // Openings echoes the runtime contract version on every response as
  // `Openings-Version`. Prefer it over the generic
  // api-version / x-api-version probes OSBP coded defensively before Openings
  // chose a header name, so the served contract version lands in the neutral
  // UpstreamMeta.api_version slot and the audit log.
  const apiVersion =
    response.headers.get("openings-version") ??
    response.headers.get("api-version") ??
    response.headers.get("x-api-version");
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
    if (name === "retry-after" || name === "ratelimit" || name === "ratelimit-policy" || name.startsWith("x-ratelimit-")) {
      (meta.ratelimit ??= {})[name] = value;
    }
  }

  return meta;
}

// Openings embeds the customer phone in the history path
// (/v1/appointments/history/{phoneNumber}), and UpstreamMeta flows into audit
// events, which must never carry customer contact details. Replace any path
// segment that decodes to a phone-like value or contains "@" before recording.
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

function redactDiagnosticText(text: string): string {
  return text
    .replace(
      /\b(code|verification(?:Code| code)?)(["'\s:=]+)\d{4,8}\b/gi,
      (_match, label: string, separator: string) => `${label}${separator}[redacted]`
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (match) => {
      const digits = match.replace(/\D/g, "");
      const trimmed = match.trim();
      const phoneLike =
        trimmed.startsWith("+") ||
        digits.length >= 10 ||
        /\(\d{3}\)/.test(trimmed) ||
        /^\d{3}[-.]\d{4}$/.test(trimmed);
      return phoneLike ? "[redacted]" : match;
    });
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

interface IdempotencyEntry {
  payloadHash: string;
  result: AdapterResult<Receipt>;
  booking: Booking;
}

interface InFlightBooking {
  payloadHash: string;
  promise: Promise<AdapterResult<Receipt>>;
}

export interface OpeningsIdempotencyKeyInspection {
  configured: boolean;
  storeExists: boolean;
  keyPresent: boolean;
}

export function hasOpeningsIdempotencyKey(path: string | undefined, key: string): boolean {
  const store = readIdempotencyStoreObject(path);
  return store ? Object.hasOwn(store, key) : false;
}

export function inspectOpeningsIdempotencyKey(path: string | undefined, key: string): OpeningsIdempotencyKeyInspection {
  if (!path) {
    return { configured: false, storeExists: false, keyPresent: false };
  }

  const store = readIdempotencyStoreObject(path, { strict: true });
  return {
    configured: true,
    storeExists: Boolean(store),
    keyPresent: store ? Object.hasOwn(store, key) : false
  };
}

export function removeOpeningsIdempotencyKey(path: string | undefined, key: string): boolean {
  if (!path) {
    return false;
  }
  const store = readIdempotencyStoreObject(path);
  if (!store || !Object.hasOwn(store, key)) {
    return false;
  }

  delete store[key];
  writeIdempotencyStoreObject(path, store);
  return true;
}

function readIdempotencyStoreObject(path: string | undefined, options: { strict?: boolean } = {}): Record<string, unknown> | undefined {
  if (!path) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      if (options.strict) {
        throw new Error("malformed idempotency store: expected object");
      }
      return undefined;
    }
    if (options.strict) {
      validateIdempotencyStoreObject(parsed);
    }
    return { ...parsed };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    if (options.strict) {
      if (error instanceof SyntaxError || isSanitizedIdempotencyValidationError(error)) {
        throw error;
      }
      throw new Error(`unreadable idempotency store: ${idempotencyPersistenceFailureReason(error)}`);
    }
    return undefined;
  }
}

function validateIdempotencyStoreObject(store: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(store)) {
    if (!isIdempotencyEntry(value)) {
      throw new Error(`malformed idempotency entry ${JSON.stringify(key)}`);
    }
  }
}

function isSanitizedIdempotencyValidationError(error: unknown): error is Error {
  return error instanceof Error &&
    /^malformed idempotency (store|entry)(:| )/.test(error.message);
}

function writeIdempotencyStoreObject(path: string, store: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, path);
}

function loadIdempotencyStore(path: string | undefined): Map<string, IdempotencyEntry> {
  if (!path) {
    return new Map();
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      console.warn("[openings-adapter] ignoring malformed idempotency store: expected object");
      return new Map();
    }

    const entries = Object.entries(parsed).filter((entry): entry is [string, IdempotencyEntry] => {
      const [key, value] = entry;
      const valid = isIdempotencyEntry(value);
      if (!valid) {
        console.warn(`[openings-adapter] ignoring malformed idempotency entry ${JSON.stringify(key)}`);
      }
      return valid;
    });
    return new Map(entries);
  } catch (error) {
    if (isNodeError(error) && error.code !== "ENOENT") {
      console.warn(`[openings-adapter] ignoring unreadable idempotency store: ${idempotencyPersistenceFailureReason(error)}`);
    }
    return new Map();
  }
}

function saveIdempotencyStore(path: string | undefined, entries: Map<string, IdempotencyEntry>): void {
  if (!path) {
    return;
  }

  // The idempotency store persists booking ids and customer ids
  // (capability-shaped values). Create the directory and file owner-only so
  // another local process under a permissive umask cannot read them by default.
  // The mode applies on creation; a pre-existing store keeps its current mode.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, path);
}

function idempotencyPersistenceFailureReason(error: unknown): string {
  if (isNodeError(error) && error.code) {
    return error.code;
  }
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "unknown";
}

function localCacheReplay<T>(result: AdapterResult<T>): AdapterResult<T> {
  return {
    ...result,
    osbp_runtime: {
      ...result.osbp_runtime,
      idempotency: "local_cache_replay",
      message: "No Openings create call was made; this result was replayed from local OSBP idempotency state."
    }
  };
}

function isIdempotencyEntry(value: unknown): value is IdempotencyEntry {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.payloadHash === "string" &&
    isAdapterReceiptResult(value.result) &&
    isRecord(value.booking) &&
    typeof value.booking.id === "string";
}

function isAdapterReceiptResult(value: unknown): value is AdapterResult<Receipt> {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return false;
  }
  if (value.ok === true) {
    return isRecord(value.value) && typeof value.value.id === "string" && typeof value.value.booking_id === "string";
  }
  return isRecord(value.problem) && typeof value.problem.code === "string" && typeof value.problem.message === "string";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function envString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
  const normalized = envString(value)?.toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const normalized = envString(value);
  if (!normalized) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function splitEnvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function ok<T>(value: T): AdapterResult<T> {
  return { ok: true, value };
}

function missingConfig<T>(name: string): AdapterResult<T> {
  return {
    ok: false,
    problem: {
      code: "missing_config",
      message: `${name} is required`,
      retryable: false
    }
  };
}

function unsupportedVerificationPurpose<T>(purpose: string, expected: string): AdapterResult<T> {
  return {
    ok: false,
    problem: {
      code: "invalid_verification_purpose",
      message: `verification purpose ${JSON.stringify(purpose)} is outside OSBP v0.1.0 scope; use ${JSON.stringify(expected)}`,
      retryable: false
    }
  };
}

function unsupportedOpeningsVerify<T>(purpose: string | undefined): AdapterResult<T> {
  const describedPurpose = purpose ?? "booking:{salonId}";
  return {
    ok: false,
    problem: {
      code: "invalid_verification_purpose",
      message:
        `verification.verify is not supported by the Openings v0.1.0 adapter for ${JSON.stringify(describedPurpose)}; ` +
        "pass the raw verification code to booking.create because Openings verification.verify consumes the booking session",
      retryable: false
    }
  };
}

function requireBookingVerificationPurpose(inputPurpose: string | undefined, salonId: string): AdapterResult<string> {
  const expected = `booking:${salonId}`;
  const purpose = inputPurpose ?? expected;
  return purpose === expected ? ok(purpose) : unsupportedVerificationPurpose(purpose, expected);
}

function idempotencyConflict(): AdapterResult<Receipt> {
  return {
    ok: false,
    problem: {
      code: "idempotency_conflict",
      message: "idempotency_key was reused with a different booking payload",
      retryable: false
    }
  };
}

function problemFromCreateError(error: unknown): AdapterResult<Receipt> | undefined {
  if (!(error instanceof OpeningsHttpError)) {
    return undefined;
  }

  // This mapping is intentionally the most commented part of the adapter:
  // future adapters should translate platform-specific failure details into the
  // smallest OSBP action the agent can safely take. HTTP status alone is not
  // enough. Openings uses 429 for both real rate limits and durable booking
  // blocks, and 409 can mean slot contention today or native idempotency states
  // once the adapter adopts the upstream Idempotency-Key header.
  //
  // We parse the upstream machine code for control flow only. Do not put
  // error.body in Problem.message: booking and verification errors can echo a
  // phone number, email address, or raw verification code, and Problem.message
  // goes to both the agent context and the audit log.
  switch (openingsErrorCode(error)) {
    case "VERIFICATION_REQUIRED":
      return requiresVerificationProblem();
    case "VERIFICATION_FAILED":
      return verificationFailedProblem();
    case "SLOT_CONFLICT":
      return slotTakenProblem();
    case "RATE_LIMITED":
      return rateLimitedProblem();
    case "BOOKING_BLOCKED":
      return blockedCreateProblem("openings_booking_blocked", "Openings blocked this booking; stop automated booking and request human handoff");
    case "CUSTOMER_BLOCKED":
      return blockedCreateProblem("openings_customer_blocked", "Openings blocked this customer from booking; stop automated booking and request human handoff");
    case "IDEMPOTENCY_KEY_CONFLICT":
      // OSBP v0.1.0 still dedupes locally and does not send the native
      // Idempotency-Key header, but the published Openings contract includes
      // this response. Keep the mapping here so adopting the native header later
      // does not accidentally tell the agent the slot was taken.
      return {
        ok: false,
        problem: {
          code: "idempotency_conflict",
          message: "Openings reported an idempotency-key conflict; start a fresh booking attempt with a new key",
          retryable: false
        }
      };
    case "IDEMPOTENCY_KEY_PROCESSING":
      // There is no protocol-level "same mutation still in flight" problem in
      // v0.1.0. Use an adapter-specific code and mark it retryable: the safe
      // action is to retry the exact same payload/key after a short delay, not
      // to choose a new slot or generate a new logical booking.
      return {
        ok: false,
        problem: {
          code: "openings_idempotency_processing",
          message: "Openings is still processing a booking request with this idempotency key; retry the same request shortly",
          retryable: true
        }
      };
  }

  // Status fallbacks exist for older or degraded responses that do not include
  // the structured Openings error.code. Keep these narrower than the code-based
  // mapping above: whenever Openings sends a machine code, the code wins.
  if (error.status === 428) {
    return requiresVerificationProblem();
  }
  if (error.status === 410) {
    return verificationFailedProblem();
  }
  if (isSlotConflict(error)) {
    return slotTakenProblem();
  }

  return undefined;
}

function openingsErrorCode(error: OpeningsHttpError): string | undefined {
  try {
    const parsed = JSON.parse(error.body) as unknown;
    return stringField(asRecord(asRecord(parsed).error), "code");
  } catch {
    return undefined;
  }
}

function requiresVerificationProblem(): AdapterResult<Receipt> {
  return {
    ok: false,
    problem: {
      code: "requires_verification",
      message: "Openings requires customer verification before booking",
      retryable: true
    }
  };
}

function verificationFailedProblem(): AdapterResult<Receipt> {
  return {
    ok: false,
    problem: {
      code: "verification_failed",
      message: "Openings rejected the verification code; request a new code and retry booking.create",
      retryable: true
    }
  };
}

function slotTakenProblem(): AdapterResult<Receipt> {
  return {
    ok: false,
    problem: {
      code: "slot_taken",
      message: "Openings reported that the selected slot is no longer available",
      retryable: true
    }
  };
}

function rateLimitedProblem(): AdapterResult<Receipt> {
  return {
    ok: false,
    problem: {
      code: "rate_limited",
      message: "Openings rate-limited the booking request; back off and retry",
      retryable: true
    }
  };
}

function blockedCreateProblem(code: string, message: string): AdapterResult<Receipt> {
  return {
    ok: false,
    problem: {
      code,
      message,
      retryable: false
    }
  };
}

// Allowlisted, PII-free identity written to the Openings appointment `metadata`
// map (string->string, values <=500 chars per the OpenAPI). Closed key set on
// purpose: never add customer.* here. `metadata` surfaces only on the
// authenticated owner/member read path, so treat it as merchant-visible.
function buildAppointmentMetadata(input: BookingCreateInput): Record<string, string> {
  return {
    osbp_idempotency_key: input.idempotency_key,
    osbp_mandate_id: input.mandate.id,
    osbp_source: OSBP_SOURCE
  };
}

function problemFromError<T>(code: string, error: unknown): AdapterResult<T> {
  if (error instanceof OpeningsMissingConfigError) {
    return missingConfig(error.setting);
  }

  if (error instanceof OpeningsHttpError) {
    return {
      ok: false,
      problem: {
        // A 429 is a portable, agent-actionable signal, so it gets the
        // protocol-level `rate_limited` code rather than an operation-specific
        // one. error.message is body-free and path-redacted; the raw upstream
        // body is never put in Problem.message (it reaches the agent context and
        // the key-based audit redactor would not scrub a body concatenated into
        // `message`). The full body goes to stderr only, for operators.
        code: error.status === 429 ? "rate_limited" : code,
        message: error.message,
        // Rate limits and transient upstream (5xx) failures are safe to retry;
        // a 4xx that reached here (bad request, auth, not found) is not.
        retryable: error.status === 429 || error.status >= 500
      }
    };
  }

  return {
    ok: false,
    problem: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: false
    }
  };
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function extractArray(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  const record = asRecord(value);
  for (const key of ["data", "items", "locations", "schedules", "services", "results"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }

    if (isRecord(candidate)) {
      const nested = extractArray(candidate);
      if (nested.length > 0) {
        return nested;
      }
    }
  }

  return [];
}

function mapSalon(value: unknown, fallbackId: string | undefined): OpeningsSalon {
  const record = unwrapRecord(value, ["data", "salon", "business"]);

  return {
    id: stringField(record, "id") ?? fallbackId ?? "",
    name: stringField(record, "name") ?? stringField(record, "title"),
    slug: stringField(record, "slug"),
    domain: stringField(record, "domain"),
    phoneNumber: stringField(record, "phoneNumber") ?? stringField(record, "phone"),
    supportEmail: stringField(record, "supportEmail") ?? stringField(record, "email"),
    instagramHandle: stringField(record, "instagramHandle"),
    timezone: stringField(record, "timezone"),
    currency: stringField(record, "currency"),
    country: stringField(record, "country"),
    totalLocations: numberField(record, "totalLocations"),
    cancellationPolicyNote: stringField(record, "cancellationPolicyNote"),
    cancellationPolicyEnabled: booleanField(record, "cancellationPolicyEnabled"),
    cancellationPolicyHours: numberField(record, "cancellationPolicyHours"),
    lateGraceMinutes: numberField(record, "lateGraceMinutes"),
    verificationMethod: stringField(record, "verificationMethod")
  };
}

function mapService(
  value: unknown,
  currency?: string
): Service | undefined {
  const record = unwrapRecord(value, ["data", "service"]);
  const id = stringField(record, "id");
  if (!id) {
    return undefined;
  }

  // Prefer the per-service currency when Openings sends one; otherwise fall back
  // to the salon-level currency the caller passes in. Openings reports currency
  // on the salon record, not on individual services, so the salon value is the
  // usual source.
  const serviceCurrency = stringField(record, "currency") ?? currency;

  return {
    id,
    name: stringField(record, "name") ?? stringField(record, "title") ?? id,
    duration: minutesToIso8601Duration(numberField(record, "duration") ?? numberField(record, "durationMinutes")),
    price: moneyField(record, "price", serviceCurrency),
    requires_consultation: booleanField(record, "hasConsultation"),
    options: mapServiceOptions(record.options, serviceCurrency)
  };
}

function mapServiceOptions(
  value: unknown,
  currency: string | undefined
): ServiceOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const mapped = value
    .filter(isRecord)
    .map((record): ServiceOption | undefined => {
      const id = stringField(record, "id");
      if (!id) {
        return undefined;
      }
      return {
        id,
        name: stringField(record, "name") ?? stringField(record, "title"),
        price: moneyField(record, "price", currency),
        duration: minutesToIso8601Duration(numberField(record, "duration") ?? numberField(record, "durationMinutes"))
      };
    })
    .filter(isPresent);

  return mapped.length > 0 ? mapped : undefined;
}

function mapLocationSchedule(value: unknown): LocationSchedule | undefined {
  const record = asRecord(value);
  const id = stringField(record, "id");
  if (!id) {
    return undefined;
  }

  return {
    id,
    name: stringField(record, "name") ?? stringField(record, "title"),
    slug: stringField(record, "slug"),
    address: stringField(record, "address") ?? stringField(record, "formattedAddress"),
    timezone: stringField(record, "timezone"),
    latitude: numberField(record, "lat") ?? numberField(record, "latitude"),
    longitude: numberField(record, "lng") ?? numberField(record, "longitude"),
    hours: mapOperatingHours(record.hours)
  };
}

export function mapOperatingHours(value: unknown): OperatingHours[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const mapped = value
    .filter(isRecord)
    .map((record): OperatingHours | undefined => {
      const day = numberField(record, "day");
      const open = stringField(record, "open");
      const close = stringField(record, "close");
      // Openings may mark a listed day closed; OSBP represents closed days by
      // omission (presence means open), so drop them here instead of surfacing
      // a closed row.
      const isOpenRaw = booleanField(record, "isOpen");
      if (day === undefined || !open || !close || isOpenRaw === false) {
        return undefined;
      }
      return {
        // Openings sends JS getDay numbering (0 = Sunday). OSBP exposes ISO 8601
        // weekday (1 = Monday, 7 = Sunday).
        day: openingsDayToIso8601(day),
        open,
        close
      };
    })
    .filter(isPresent);

  return mapped.length > 0 ? mapped : undefined;
}

function mapPolicy(salon: OpeningsSalon, service: JsonRecord, serviceId: string): Policy {
  service = unwrapRecord(service, ["data", "service"]);
  const paymentRequirement = stringField(service, "paymentRequirement")?.toLowerCase();
  const verificationMethod = salon.verificationMethod?.toLowerCase();

  return {
    service_id: serviceId,
    cancellation_enabled: salon.cancellationPolicyEnabled,
    cancellation_window: hoursToIso8601Duration(salon.cancellationPolicyHours),
    cancellation_note: salon.cancellationPolicyNote,
    late_grace: minutesToIso8601Duration(salon.lateGraceMinutes),
    // Conditional liability fees, surfaced IF Openings exposes them. Openings
    // has no cancellation-fee / no-show-fee amount on the service or salon shape
    // today, so moneyField returns undefined and the fields are stripped from
    // the response. They appear automatically when a real platform populates
    // them. Read off the service record, mirroring depositAmount below; do NOT
    // invent a value. OSBP does not yet enforce or cap these through the
    // mandate (roadmap, tied to payment composition).
    cancellation_fee: moneyField(service, "cancellationFeeAmount", salon.currency),
    no_show_fee: moneyField(service, "noShowFeeAmount", salon.currency),
    payment_requirement:
      paymentRequirement === "deposit"
        ? "deposit"
        : paymentRequirement === "full"
          ? "full_prepay"
          : paymentRequirement === "none"
            ? "none"
            : "unknown",
    deposit: moneyField(service, "depositAmount", salon.currency),
    verification_method:
      verificationMethod === "sms" || verificationMethod === "email"
        ? verificationMethod
        : "unknown",
    organization: {
      id: salon.id,
      name: salon.name,
      slug: salon.slug,
      domain: salon.domain,
      phone: salon.phoneNumber,
      support_email: salon.supportEmail,
      instagram_handle: salon.instagramHandle,
      timezone: salon.timezone,
      currency: salon.currency,
      country: salon.country,
      total_locations: salon.totalLocations
    }
  };
}

function mapBooking(
  value: unknown,
  input: BookingCreateInput,
  customerId: string,
  scheduleTimezone: string | undefined
): Booking {
  const record = unwrapRecord(value, ["data", "appointment", "booking"]);
  const id =
    stringField(record, "id") ??
    stringField(record, "appointmentId") ??
    stringField(record, "bookingId") ??
    `openings_${input.idempotency_key}`;

  const startsAtLocal = `${input.date}T${input.time.length === 5 ? `${input.time}:00` : input.time}`;

  return dropUndefined({
    id,
    status: normalizeBookingStatus(stringField(record, "status")),
    service_id: input.service_id,
    schedule_id: input.schedule_id,
    provider_id: input.provider_id,
    // Canonical absolute instant, derived from the merchant-local wall-clock
    // plus the salon's IANA tz. Left undefined (and stripped) when the tz is
    // unknown, mirroring Slot.
    starts_at: wallClockToInstant(startsAtLocal, scheduleTimezone),
    starts_at_local: startsAtLocal,
    schedule_timezone: scheduleTimezone,
    customer_id: customerId
  }) as Booking;
}

// The phone/email history probe returns a `HistoryProbeResponse` with no
// appointment records, so there is nothing to map here. Readback by id uses
// the review endpoint below.

// Map Openings' public appointment review payload
// (GET /v1/appointments/{id}/review) onto an OSBP Booking. The endpoint is an
// id-as-capability confirmation read.
//
// Deferred (v0.3.0 ship-set 3): live capture shows three gaps: provider is
// teamMemberId (not userId), times are UTC-only (no wall-clock/tz), services[]
// has no referenceId. booking.status is safe: it reads the local idempotency
// record first and only falls back here when an id is present.
//
// Unlike the create mapper, an absent platform status reads as "unknown", not
// "booked": a readback must not assume the appointment is still live.
function mapReviewBooking(value: unknown, fallbackId: string): Booking {
  const record = unwrapRecord(value, ["data", "appointment", "booking"]);
  const servicesValue = Array.isArray(record["services"]) ? record["services"][0] : record["service"];
  const service = unwrapRecord(servicesValue, []);
  const schedule = unwrapRecord(record["schedule"], []);
  const provider = unwrapRecord(
    record["user"] ?? record["provider"] ?? record["teamMember"] ?? record["member"],
    []
  );
  const customer = unwrapRecord(record["customer"], []);

  const date = stringField(record, "date");
  const time = stringField(record, "time");
  const startsAtLocalField = stringField(record, "startsAtLocal");
  const startsAtLocal =
    date && time
      ? `${date}T${time.length === 5 ? `${time}:00` : time}`
      : startsAtLocalField && !hasExplicitOffset(startsAtLocalField)
        ? startsAtLocalField
        : undefined;

  const rawStatus = stringField(record, "status");

  return dropUndefined({
    id:
      stringField(record, "id") ??
      stringField(record, "appointmentId") ??
      stringField(record, "bookingId") ??
      fallbackId,
    status: rawStatus ? normalizeBookingStatus(rawStatus) : "unknown",
    service_id:
      stringField(record, "serviceId") ?? stringField(service, "id") ?? stringField(service, "serviceId"),
    schedule_id:
      stringField(record, "scheduleId") ?? stringField(schedule, "id") ?? stringField(schedule, "scheduleId"),
    provider_id:
      stringField(record, "userId") ??
      stringField(record, "providerId") ??
      stringField(provider, "id") ??
      stringField(provider, "userId"),
    starts_at_local: startsAtLocal,
    customer_id: stringField(record, "customerId") ?? stringField(customer, "id")
  }) as Booking;
}

function hasExplicitOffset(value: string): boolean {
  return /Z$/i.test(value) || /[+-]\d{2}:?\d{2}$/.test(value);
}

function extractSlots(
  value: unknown,
  input: AvailabilityFindInput & {
    service_id: string;
    schedule_id: string;
    organization_id?: string;
    organization_name?: string;
    organization_currency?: string;
    organization_timezone?: string;
    locations_by_id?: Map<string, LocationSchedule>;
  }
): Slot[] {
  const records = collectSlotRecords(value, input.service_id);
  const slots: Slot[] = [];

  for (const record of records) {
    const time = stringField(record, "time") ?? stringField(record, "startTime") ?? stringField(record, "startsAt");
    const date = stringField(record, "date") ?? input.date;
    if (!time) {
      continue;
    }

    const staffMemberId =
      stringField(record, "userId") ??
      stringField(record, "staffUserId") ??
      stringField(record, "memberId") ??
      stringField(record, "staffMemberId") ??
      input.provider_id;
    const staffMemberName =
      stringField(record, "staffMemberName") ??
      stringField(record, "name") ??
      stringField(record, "displayName") ??
      stringField(record, "fullName") ??
      joinNameParts(stringField(record, "firstName"), stringField(record, "lastName"));
    const staffMemberPhoto = stringField(record, "staffMemberPhoto") ?? stringField(record, "photo");
    const staffHasPortfolio = booleanField(record, "staffHasPortfolio");
    const startsAt = toStartsAt(date, time);
    const scheduleId = stringField(record, "scheduleId") ?? input.schedule_id;
    // Address comes from /v1/locations, which is keyed by the location-level
    // schedule_id (the value the caller requested). The openings/members
    // response embeds a per-provider sub-schedule.id that does NOT appear in
    // /v1/locations, so look up against input.schedule_id, then fall back to
    // the per-record id in case Openings ever changes that.
    const locationFallback =
      input.locations_by_id?.get(input.schedule_id) ??
      input.locations_by_id?.get(scheduleId);
    const scheduleName = stringField(record, "scheduleTitle") ?? locationFallback?.name;
    const scheduleAddress = locationFallback?.address;
    const scheduleLatitude = locationFallback?.latitude;
    const scheduleLongitude = locationFallback?.longitude;
    const scheduleHours = locationFallback?.hours;
    // schedule_timezone authoritative for starts_at_local and schedule_hours,
    // and the tz used to derive the absolute instant starts_at.
    // Prefer the location's own tz; fall back to the salon's configured tz so
    // single-location businesses (where /v1/locations may omit the field) still
    // surface a usable IANA name. Without this, agents have to round-trip
    // through policy.explain to interpret slot times.
    const scheduleTimezone = locationFallback?.timezone ?? input.organization_timezone;
    const serviceId = stringField(record, "serviceId") ?? input.service_id;

    const price = moneyField(record, "price", input.organization_currency);
    const slot: Slot = {
      id: [scheduleId, staffMemberId, serviceId, startsAt].filter(Boolean).join(":"),
      organization_id: input.organization_id,
      schedule_id: scheduleId,
      schedule_name: scheduleName,
      schedule_address: scheduleAddress,
      schedule_latitude: scheduleLatitude,
      schedule_longitude: scheduleLongitude,
      schedule_hours: scheduleHours,
      schedule_timezone: scheduleTimezone,
      provider_id: staffMemberId,
      provider_name: staffMemberName,
      provider_image_url: staffMemberPhoto,
      provider_has_portfolio: staffHasPortfolio,
      service_id: serviceId,
      // starts_at is the canonical absolute instant computed from the
      // merchant-local wall-clock plus the schedule's IANA tz; starts_at_local
      // keeps the wall-clock value Openings stores and round-trips into
      // booking.create. starts_at is left undefined when the tz is unknown
      // (wallClockToInstant returns undefined), and dropUndefined strips it.
      starts_at: wallClockToInstant(startsAt, scheduleTimezone),
      starts_at_local: startsAt,
      price,
      organization_name: input.organization_name
    };
    // Drop undefined keys so MCP responses stay compact and slot equality
    // checks (idempotency cache, tests) don't trip on absent-vs-undefined.
    slots.push(dropUndefined(slot) as Slot);
  }

  return dedupeSlots(slots);
}

function collectSlotRecords(value: unknown, requestedServiceId?: string): JsonRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectSlotRecords(entry, requestedServiceId));
  }

  if (!isRecord(value)) {
    return [];
  }

  const directTime = stringField(value, "time") ?? stringField(value, "startTime") ?? stringField(value, "startsAt");
  const openings = value.openings;
  if (Array.isArray(openings)) {
    const staffMemberId =
      stringField(value, "userId") ??
      stringField(value, "staffUserId") ??
      stringField(value, "memberId") ??
      stringField(value, "teamMemberId") ??
      stringField(value, "username") ??
      stringField(value, "staffMemberId");
    const staffMemberName =
      stringField(value, "name") ??
      stringField(value, "displayName") ??
      stringField(value, "fullName") ??
      joinNameParts(stringField(value, "firstName"), stringField(value, "lastName"));
    const staffMemberPhoto = stringField(value, "photo") ?? stringField(value, "photoUrl");
    const staffHasPortfolio = booleanField(value, "hasPortfolio");
    const schedule = isRecord(value.schedule) ? value.schedule : {};
    const scheduleTitle =
      stringField(schedule, "title") ??
      stringField(schedule, "name") ??
      stringField(schedule, "label");
    const service = selectMemberService(value.services, requestedServiceId);

    return openings
      .filter((opening): opening is string => typeof opening === "string" && opening.length > 0)
      .map((opening) => ({
        date: stringField(value, "date"),
        time: opening,
        staffMemberId,
        staffMemberName,
        staffMemberPhoto,
        staffHasPortfolio,
        scheduleId: stringField(schedule, "id"),
        scheduleTitle,
        // Prefer the salon-level `referenceId` over the per-provider copy `id`.
        // Openings exposes a "service copy" record per provider that links
        // back to the canonical salon service via referenceId; emitting the
        // canonical id keeps Slot.service_id symmetric with service.describe
        // (so a mandate built from describe round-trips through availability),
        // and `/v1/appointments/create` takes the salon-level service id. The
        // neighboring scheduleId resolves to the leaf id instead because
        // Openings accepts the per-provider sub-schedule at create time;
        // only the service case is anchored to the parent.
        serviceId: service
          ? stringField(service, "referenceId") ?? stringField(service, "id")
          : undefined,
        price: service ? numberField(service, "price") : undefined
      }));
  }

  const nested = Object.values(value).flatMap((entry) => {
    if (Array.isArray(entry) || isRecord(entry)) {
      return collectSlotRecords(entry, requestedServiceId);
    }

    return [];
  });

  return directTime ? [value, ...nested] : nested;
}

function selectMemberService(services: unknown, requestedServiceId?: string): JsonRecord | undefined {
  if (!Array.isArray(services)) {
    return undefined;
  }

  const serviceRecords = services.filter(isRecord);
  return serviceRecords.find((service) =>
    stringField(service, "id") === requestedServiceId ||
    stringField(service, "referenceId") === requestedServiceId
  ) ?? serviceRecords[0];
}

function dedupeSlots(slots: Slot[]): Slot[] {
  const seen = new Set<string>();
  return slots.filter((slot) => {
    if (seen.has(slot.id)) {
      return false;
    }

    seen.add(slot.id);
    return true;
  });
}

function toStartsAt(date: string, time: string): string {
  if (time.includes("T")) {
    return time;
  }

  return `${date}T${time.length === 5 ? `${time}:00` : time}`;
}

// Merchant-local wall-clock (no offset) -> UTC RFC 3339 instant, via the
// schedule IANA tz. DST-correct: it resolves the wall-clock string in the
// target zone (not the host's), so the same "09:00" maps to a different UTC
// instant across a DST boundary. No new dependency. Intl.DateTimeFormat
// carries the IANA tz database. Returns undefined when timeZone is missing,
// so callers leave Slot/Booking.starts_at absent rather than guessing an
// instant.
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
  const p = Object.fromEntries(dtf.formatToParts(new Date(guessUTC)).map((x) => [x.type, x.value]));
  const asTz = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guessUTC - (asTz - guessUTC)).toISOString();
}

function nextDateIso(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// OSBP exposes durations as ISO 8601 strings ("PT45M", "PT24H") rather than
// bare integers; Openings reports plain numbers. Single-unit output keeps the
// value lossless (90 minutes stays "PT90M", not "PT1H30M") and matches the spec
// examples. Returns undefined for an absent or non-finite input so the
// null-stripping rule drops the field entirely.
function minutesToIso8601Duration(minutes: number | undefined): string | undefined {
  if (minutes === undefined || !Number.isFinite(minutes)) {
    return undefined;
  }
  return `PT${minutes}M`;
}

function hoursToIso8601Duration(hours: number | undefined): string | undefined {
  if (hours === undefined || !Number.isFinite(hours)) {
    return undefined;
  }
  return `PT${hours}H`;
}

// Parses an ISO 8601 duration of the shape this adapter emits ("PT45M", "PT1H",
// "PT1H30M") back into whole minutes. Returns undefined for an absent or
// unparseable value so callers fall back rather than guess a booking window.
function iso8601DurationToMinutes(duration: string | undefined): number | undefined {
  if (duration === undefined) {
    return undefined;
  }
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    return undefined;
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 60 + minutes + Math.floor(seconds / 60);
}

// Adds whole minutes to a merchant-local wall-clock string
// ("YYYY-MM-DDTHH:MM:SS") without involving the host timezone. The value is
// treated as UTC purely for calendar arithmetic (so hour and day rollover are
// handled), then formatted back to the same offset-free wall-clock shape. This
// never reads the host tz, so it is safe under the time-field discipline rule.
function addMinutesToWallClock(wallClock: string, minutes: number): string | undefined {
  const asUtc = new Date(`${wallClock}Z`);
  if (Number.isNaN(asUtc.getTime())) {
    return undefined;
  }
  asUtc.setUTCMinutes(asUtc.getUTCMinutes() + minutes);
  return asUtc.toISOString().slice(0, 19);
}

// Openings numbers weekdays with the JS getDay convention (0 = Sunday,
// 6 = Saturday). OSBP exposes ISO 8601 weekdays (1 = Monday through 7 = Sunday),
// so Sunday moves from 0 to 7 and the other days are unchanged.
function openingsDayToIso8601(day: number): number {
  return day === 0 ? 7 : day;
}

// Map Openings' native appointment status onto OSBP's closed BookingStatus
// enum. The platform is the system of record for the status, so the adapter
// normalizes whatever it sends; an unrecognized status becomes "unknown". An
// absent status on a create response reads as "booked", since the appointment
// was just created (this preserves the prior "confirmed" default behavior).
function normalizeBookingStatus(raw: string | undefined): BookingStatus {
  switch (raw?.toLowerCase()) {
    case "booked":
    case "confirmed":
    case "active":
    case "scheduled":
      return "booked";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "completed":
    case "done":
    case "finished":
      return "completed";
    case "no_show":
    case "noshow":
    case "no-show":
      return "no_show";
    case "pending":
    case "requested":
      return "pending";
    case undefined:
      return "booked";
    default:
      return "unknown";
  }
}

// ISO 4217 minor-unit exponents that differ from the default of 2. The
// exponent VARIES by currency: most use 2 (USD, EUR), some use 0 (JPY, KRW),
// some use 3 (KWD, BHD, OMR), and a small number of fund-style codes use 4.
// Snapshot reviewed against ISO 4217 / CLDR on 2026-07-07; recheck before
// changing this table or onboarding a new merchant currency.
// Keep this list current with ISO 4217/CLDR rather than adding one-off
// currencies as merchants appear.
const CURRENCY_MINOR_UNIT_EXPONENT: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4
};

function minorUnitExponent(currency: string | undefined): number {
  if (!currency) {
    return 2;
  }
  return CURRENCY_MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

// Openings reports prices in MAJOR currency units (e.g., price: 80 means
// $80.00), so this scales to integer minor units using the currency's ISO 4217
// exponent. COPY HAZARD: two traps live here. First, do not reuse this for
// platforms whose money fields are already minor units (Square or Stripe-style
// amounts), pass those through unscaled, or you get 100x prices. Second, the
// minor-unit exponent is NOT always 2 (cents): CLP and JPY use 0, JOD and
// KWD use 3, and CLF uses 4, so the scale factor depends on the currency, not
// a fixed *100.
function toMinorUnits(record: JsonRecord, key: string, currency: string | undefined): number | undefined {
  const value = numberField(record, key);
  if (value === undefined) {
    return undefined;
  }

  return Math.round(value * 10 ** minorUnitExponent(currency));
}

// Build a Money object from a major-unit field on an Openings record. Returns
// undefined when the salon currency is unknown (Money.currency is required, so
// without it there is no valid Money) or the amount field is absent. type is
// "fixed" because every Openings price field carries a concrete amount.
function moneyField(
  record: JsonRecord,
  key: string,
  currency: string | undefined
): Money | undefined {
  if (!currency) {
    return undefined;
  }
  const amountMinor = toMinorUnits(record, key, currency);
  if (amountMinor === undefined) {
    return undefined;
  }
  return {
    amount_minor: amountMinor,
    currency,
    type: "fixed",
    display: formatMoney(amountMinor, currency)
  };
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatMoney(amountMinor: number | undefined, currency: string | undefined): string | undefined {
  if (amountMinor === undefined || !currency) {
    return undefined;
  }
  // Convert minor units back to a major-unit decimal using the currency's ISO
  // 4217 exponent so non-cents currencies (JPY at 0, KWD at 3) format correctly,
  // not just /100.
  const exponent = minorUnitExponent(currency);
  const major = amountMinor / 10 ** exponent;
  // display is a non-canonical presentation hint; the canonical value is
  // amount_minor + currency, which agents SHOULD reformat in the end user's
  // locale. Openings exposes no locale or language on the salon/organization
  // record, so pin a deterministic English display hint until a real merchant
  // locale exists rather than letting the host's LANG/ICU environment leak
  // into the wire.
  const locale = "en-US";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent
    }).format(major);
  } catch {
    // Intl throws on unknown currency codes. Fall back to a plain numeric
    // string with the currency code suffix so the agent still has something
    // to show the user.
    return `${major.toFixed(exponent)} ${currency.toUpperCase()}`;
  }
}

function joinNameParts(first?: string, last?: string): string | undefined {
  const joined = [first, last].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ");
  return joined.length > 0 ? joined : undefined;
}

function customerNameParts(customer: BookingCreateInput["customer"]): { firstName: string; lastName: string } | undefined {
  const givenName = customer?.given_name?.trim();
  const familyName = customer?.family_name?.trim();
  if (givenName && familyName) {
    return { firstName: givenName, lastName: familyName };
  }

  const parts = customer?.display_name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length !== 2) {
    return undefined;
  }
  return { firstName: parts[0], lastName: parts[1] };
}

function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
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

function normalizeBookingCreateInput(input: BookingCreateInput): AdapterResult<BookingCreateInput> {
  const time = normalizeBookingTime(input.time);
  if (!time) {
    return {
      ok: false,
      problem: {
        code: "invalid_booking_time",
        message: "BookingCreateInput.time must be merchant-local HH:MM or HH:MM:00",
        retryable: false
      }
    };
  }

  return ok(time === input.time ? input : { ...input, time });
}

function normalizeBookingTime(time: string): string | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(time);
  return match ? `${match[1]}:${match[2]}` : undefined;
}

function bookingApprovalSummary(
  input: BookingCreateInput,
  service: Service,
  slot: Slot,
  policy: Policy
): string {
  const price = displayMoney(slot.price ?? service.price);
  const deposit = displayMoney(policy.deposit);
  const cancellationFee = displayMoney(policy.cancellation_fee);
  const noShowFee = displayMoney(policy.no_show_fee);
  const customerName = customerNameForApproval(input.customer);
  const summary = [
    `Book ${service.name}`,
    customerName ? `for ${customerName}` : undefined,
    price ? `priced at ${price}` : undefined,
    `on ${input.date} at ${input.time} merchant-local time`,
    "with the selected provider",
    "at the selected location"
  ].filter(isPresent).join(" ");

  const policyParts = [
    paymentRequirementSummary(policy.payment_requirement, deposit),
    deposit && policy.payment_requirement !== "deposit" ? `deposit: ${deposit}` : undefined,
    cancellationFee ? `cancellation fee: ${cancellationFee}` : undefined,
    noShowFee ? `no-show fee: ${noShowFee}` : undefined
  ].filter(isPresent);

  return `${summary}. Policy: ${policyParts.join("; ")}.`;
}

function customerNameForApproval(customer: BookingCreateInput["customer"]): string | undefined {
  const parts = customerNameParts(customer);
  if (parts) {
    return joinNameParts(parts.firstName, parts.lastName);
  }
  const displayName = customer?.display_name?.trim();
  return displayName && displayName.length > 0 ? displayName : undefined;
}

function paymentRequirementSummary(requirement: Policy["payment_requirement"], deposit: string | undefined): string {
  switch (requirement) {
    case undefined:
    case "none":
      return "No upfront payment or deposit is required to book";
    case "deposit":
      return deposit ? `A deposit of ${deposit} is required to book` : "A deposit is required to book";
    case "full_prepay":
      return "Full prepayment is required to book";
    case "unknown":
      return "The payment requirement is unknown";
  }
}

function displayMoney(money: Money | undefined): string | undefined {
  return money?.display ?? formatMoney(money?.amount_minor, money?.currency);
}

function redactTransientCreateFields(input: BookingCreateInput): unknown {
  const { verification_code: _verificationCode, approval: _approval, ...payload } = input;
  return {
    ...payload
  };
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

function isSlotConflict(error: OpeningsHttpError): boolean {
  // Structured Openings codes win before this fallback. Without a code, only
  // map business/validation statuses to slot_taken when the body actually
  // describes availability; a generic 409 can also be an idempotency or other
  // conflict that should not ask the agent to pick another slot.
  if (error.status === 400 || error.status === 409 || error.status === 422) {
    return /unavailable|slot|taken/i.test(error.body);
  }
  return false;
}

function booleanField(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function unwrapRecord(value: unknown, keys: string[]): JsonRecord {
  let record = asRecord(value);

  for (const key of keys) {
    const nested = record[key];
    if (isRecord(nested)) {
      record = nested;
    }
  }

  return record;
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
