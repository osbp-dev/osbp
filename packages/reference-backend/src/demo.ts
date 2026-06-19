import type {
  AdapterResult,
  AvailabilityFindInput,
  BookingCreateInput,
  BookingMandate,
  Money,
  Policy,
  PolicyExplainInput,
  Problem,
  Receipt,
  Service,
  ServiceDescribeInput,
  Slot
} from "@osbp/core";
import { validateMandate } from "@osbp/core";
import { SyntheticBookingAdapter, startSyntheticBookingServer, type OrganizationResponse } from "./index.js";

export interface ReferenceDemoOptions {
  now?: Date;
  color?: boolean;
  launch?: boolean;
  tape?: boolean;
  gum?: boolean;
  vertical?: string;
}

interface DemoVertical {
  id: "dental" | "auto" | "notary" | "spa";
  organizationId: string;
  serviceId: string;
  scheduleId: string;
  providerId: string;
  mandateId: string;
  idempotencyKey: string;
  customerId: string;
  cap: Money;
  intent: string;
}

interface DemoAttempt {
  organization: OrganizationResponse;
  serviceInput: ServiceDescribeInput;
  service: Service;
  availabilityInput: AvailabilityFindInput;
  slots: Slot[];
  policy: Policy;
  policyInput: PolicyExplainInput;
  slot: Slot;
  mandate: BookingMandate;
  input: BookingCreateInput;
  validation: ReturnType<typeof validateMandate>;
}

interface DemoColors {
  bold(value: string): string;
  green(value: string): string;
  red(value: string): string;
  cyan(value: string): string;
  dim(value: string): string;
}

export const GUM_BLOCK_SEPARATOR = "\x1e";

const DEMO_DATE_OFFSET_DAYS = 6;
const MANDATE_EXPIRES_AFTER_MS = 24 * 60 * 60 * 1000;

const DEMO_VERTICALS: DemoVertical[] = [
  {
    id: "dental",
    organizationId: "org_01jz7ay6r8dd6yskkpt8rvhk8z",
    serviceId: "dental_cleaning",
    scheduleId: "dental_midtown",
    providerId: "dental_dr_lee",
    mandateId: "mandate_8f44d4ab-8c56-4f6d-9e0f-d5d3e2d36f88",
    idempotencyKey: "idempotency-reference-dental-cleaning-create",
    customerId: "cus_01jz7eg2v8y0fq3k9q9m7t8n2a",
    cap: { amount_minor: 15000, currency: "USD" },
    intent: "Book a regular cleaning, up to $150.00."
  },
  {
    id: "auto",
    organizationId: "org_01jz7jevggr5st9acrxfbexvzz",
    serviceId: "auto_oil_change",
    scheduleId: "auto_berlin_shop",
    providerId: "auto_tech_anna",
    mandateId: "mandate_4cf5a8f0-7be1-4b30-8f48-2899f57d7dd2",
    idempotencyKey: "idempotency-reference-auto-berlin",
    customerId: "cus_01jz7ej5s3dt4j7x4gmx4z6t5v",
    cap: { amount_minor: 10000, currency: "EUR" },
    intent: "Book an oil change in Berlin, up to EUR 100.00."
  },
  {
    id: "notary",
    organizationId: "org_01jz7gmphxn33ertpvvx9y3yfh",
    serviceId: "notary_document",
    scheduleId: "notary_online",
    providerId: "notary_chen",
    mandateId: "mandate_9e081929-3903-44f8-a9a6-0bb1f9243444",
    idempotencyKey: "idempotency-reference-notary-remote",
    customerId: "cus_01jz7ekq7dm0ybs0gz9ws3y4g8",
    cap: { amount_minor: 2500, currency: "USD" },
    intent: "Book an online notarization, up to $25.00."
  },
  {
    id: "spa",
    organizationId: "org_01jz731qszrrnysfpdypv1kkv7",
    serviceId: "spa_swedish_massage",
    scheduleId: "spa_soho",
    providerId: "spa_amelia",
    mandateId: "mandate_0d0030f2-6125-4453-9895-8b10d2f61e3a",
    idempotencyKey: "idempotency-reference-spa-massage-create",
    customerId: "cus_01jz7em7bkak78d23bgs9y0drc",
    cap: { amount_minor: 12000, currency: "GBP" },
    intent: "Book a Swedish massage in London, up to GBP 120.00."
  }
];

const CODA: DemoVertical = {
  id: "dental",
  organizationId: "org_01jz7ay6r8dd6yskkpt8rvhk8z",
  serviceId: "dental_crown",
  scheduleId: "dental_midtown",
  providerId: "dental_dr_lee",
  mandateId: "mandate_f89d3251-4b73-4d40-8b28-6f7a2e8d00f6",
  idempotencyKey: "idempotency-reference-dental-crown-guardrail",
  customerId: "cus_01jz7eqc0zb8zk5pn0ckqkve4p",
  cap: { amount_minor: 15000, currency: "USD" },
  intent: "Try to book a crown appointment under the same $150.00 cap."
};

export async function renderReferenceDemo(options: ReferenceDemoOptions = {}): Promise<string> {
  const now = options.now ?? new Date();
  const colors = demoColors(options.color === true);
  if (options.tape) {
    return renderLaunchTapeDemo(now, colors, options.gum === true);
  }

  const verticals = selectVerticals(options);
  const lines: string[] = [
    colors.bold("OSBP reference-backend demo"),
    "Credential-free synthetic booking flow",
    `Clock: ${now.toISOString()}`,
    ""
  ];

  const server = await startSyntheticBookingServer();
  try {
    for (const vertical of verticals) {
      const adapter = adapterFor(server.url, vertical.organizationId, now);
      const attempt = await prepareAttempt(adapter, vertical, now);
      const receipt = await bookIfAuthorized(adapter, attempt);
      renderAttempt(lines, vertical.intent, attempt, receipt, colors);
      lines.push("");
    }

    if (!options.vertical) {
      const adapter = adapterFor(server.url, CODA.organizationId, now);
      const attempt = await prepareAttempt(adapter, CODA, now);
      const receipt = await bookIfAuthorized(adapter, attempt);
      lines.push(colors.bold("Fail-closed coda"));
      renderAttempt(lines, CODA.intent, attempt, receipt, colors);
      lines.push("");
    }
  } finally {
    await server.close();
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function renderLaunchTapeDemo(now: Date, colors: DemoColors, gum: boolean): Promise<string> {
  const server = await startSyntheticBookingServer();
  try {
    const dental = DEMO_VERTICALS[0];
    const adapter = adapterFor(server.url, dental.organizationId, now);
    const attempt = await prepareAttempt(adapter, dental, now);
    const receipt = await bookIfAuthorized(adapter, attempt);
    if (!receipt?.ok) {
      throw new Error(`Demo booking failed with ${receipt?.problem.code ?? "missing receipt"}`);
    }

    const codaAdapter = adapterFor(server.url, CODA.organizationId, now);
    const coda = await prepareAttempt(codaAdapter, CODA, now);
    await bookIfAuthorized(codaAdapter, coda);

    if (gum) {
      return renderGumLaunchTape(attempt, receipt.value, coda);
    }

    return [
      renderTapeCard(colors.bold("OSBP REFERENCE DEMO"), [
        colors.cyan("INTENT"),
        `Book ${attempt.service.name} at ${attempt.organization.name}`,
        `Cap: ${displayMoney(attempt.mandate.max_price)}`,
        "",
        colors.cyan("MANDATE"),
        `Service: ${attempt.service.name}`,
        `Provider: ${attempt.slot.provider_name ?? "selected provider"}`,
        `Time: ${displayLocalTime(attempt.slot)}`
      ]),
      renderTapeCard(colors.bold("LOOK"), [
        "osbp service.describe",
        "osbp availability.find",
        "osbp policy.explain",
        "",
        attempt.service.name,
        `${attempt.slot.provider_name ?? "Selected provider"}`,
        `${attempt.slot.schedule_name ?? "Selected schedule"}`,
        displayLocalTime(attempt.slot),
        `Price: ${displayMoney(attempt.slot.price ?? attempt.service.price)}`,
        `Policy: ${policyLine(attempt.policy)}`,
        "",
        colors.cyan("SERVER AUTHORIZATION GATE"),
        colors.green("PASS"),
        colors.dim("validateMandate()")
      ]),
      renderTapeCard(colors.bold("BOOK"), [
        "osbp booking.create",
        "",
        colors.cyan("RECEIPT"),
        `Booked ${attempt.service.name}`,
        `Provider: ${attempt.slot.provider_name ?? "selected provider"}`,
        `Time: ${displayLocalTime(attempt.slot)}`,
        "No payment moved"
      ]),
      renderTapeCard(colors.bold("GUARDRAIL CODA"), [
        "Try Crown appointment under $150 cap",
        "",
        colors.cyan("LOOK"),
        "osbp service.describe --service crown",
        "osbp policy.explain --service crown",
        "",
        coda.service.name,
        `Price: ${displayMoney(coda.slot.price ?? coda.service.price)}`,
        `Cap: ${displayMoney(coda.mandate.max_price)}`,
        `Policy: ${policyLine(coda.policy)}`
      ]),
      renderTapeCard(colors.bold("SERVER AUTHORIZATION GATE"), [
        colors.red("REJECT"),
        colors.dim("validateMandate()"),
        coda.validation.ok ? "unexpected pass" : coda.validation.problem.code,
        problemSummary(
          coda.validation.ok
            ? { code: "unexpected_pass", message: "Coda passed unexpectedly" }
            : coda.validation.problem,
          coda.slot.price ?? coda.service.price,
          coda.mandate.max_price
        ),
        "",
        colors.red("NO BOOKING CREATED")
      ])
    ].join("\f");
  } finally {
    await server.close();
  }
}

function renderGumLaunchTape(attempt: DemoAttempt, receipt: Receipt, coda: DemoAttempt): string {
  // Source of truth for the visible VHS transcript in osbp-dental-1.tape.
  // Keep this copy aligned with demo/osbp-dental-1-commented.txt; do not edit
  // only the commented transcript and expect the GIF renderer to pick it up.
  return [
    renderGumCard([
      {
        role: "OPENING",
        lines: [
          "OSBP (Open Service Booking Protocol)",
          "Version: v0.1.0",
          "Adapter: SyntheticBookingAdapter (reference-backend)",
          "Backend: osbp/packages/reference-backend",
          "Booking Platform: OSBP Demo Booking Platform",
          "Mode: credential-free (demo)",
          "",
          "Scenario: attempt to book a dental cleaning,",
          "max price $150, at Carolyn's Dental on July 7"
        ]
      }
    ]),
    renderPause("2s"),
    renderGumCard([
      {
        role: "COMMENT",
        lines: [
          "THE BEGINNING",
          "User's LLM receives user request to \"book a dental cleaning,",
          "             max price $150, at Carolyn's Dental on July 7\"",
          "THEN",
          "User's LLM begins making read-only OSBP JSON requests to Carolyn's Dental backend server.",
          "THEN",
          "Adapter maps those OSBP JSON requests to platform GETs."
        ]
      },
      pauseBlock("1s"),
      {
        role: "OUTBOUND",
        lines: [
          "osbp service.describe",
          ...jsonBlock(attempt.serviceInput)
        ]
      },
      pauseBlock("1s"),
      {
        role: "COMMENT",
        lines: [
          "Adapter -> Booking Platform",
          "GET /v1/organizations/org_01jz7ay6r8dd6yskkpt8rvhk8z/services/dental_cleaning"
        ]
      },
      {
        role: "INBOUND",
        lines: jsonBlock(attempt.service)
      },
      pauseBlock("1s"),
      {
        role: "COMMENT",
        lines: ["Adapter maps the platform response into an OSBP JSON Service result."]
      },
      {
        role: "OUTBOUND",
        lines: [
          "osbp availability.find",
          ...jsonBlock(attempt.availabilityInput)
        ]
      },
      pauseBlock("1s"),
      {
        role: "COMMENT",
        lines: [`Adapter -> Booking Platform: GET ${availabilityPath(attempt.organization.id, attempt.availabilityInput)}`]
      },
      {
        role: "INBOUND",
        lines: jsonBlock(attempt.slots)
      },
      pauseBlock("1s"),
      {
        role: "COMMENT",
        lines: ["Adapter maps the platform response into an OSBP JSON Slot result:"]
      },
      {
        role: "OUTBOUND",
        lines: [
          "osbp policy.explain",
          ...jsonBlock(attempt.policyInput)
        ]
      },
      pauseBlock("1s"),
      {
        role: "COMMENT",
        lines: ["Adapter -> Booking Platform: GET /v1/organizations/org_01jz7ay6r8dd6yskkpt8rvhk8z/policies/dental_cleaning"]
      },
      {
        role: "INBOUND",
        lines: jsonBlock(attempt.policy)
      },
      pauseBlock("1s"),
      {
        role: "COMMENT",
        lines: [
          "User's LLM uses those OSBP JSON facts to build a mandate.",
          "Backend server will use OSBP core to enforce it."
        ]
      },
      {
        role: "STATE",
        lines: [
          "BOOKING MANDATE",
          ...jsonBlock(attempt.mandate)
        ]
      },
      pauseBlock("1s"),
      {
        role: "STATE",
        lines: [
          "MANDATE CHECK",
          "PASS",
          "validateMandate()",
          "OSBP core: scope, time, price, and policy fit."
        ]
      }
    ]),
    renderPause("1s"),
    renderGumCard([
      {
        role: "COMMENT",
        lines: [
          "Backend server writes only after OSBP core passes.",
          "Adapter maps the OSBP JSON mutation to a platform POST."
        ]
      },
      {
        role: "OUTBOUND",
        lines: [
          "osbp booking.create",
          ...jsonBlock(attempt.input)
        ]
      },
      pauseBlock("1s"),
      {
        role: "COMMENT",
        lines: ["Adapter -> Booking Platform: POST /v1/organizations/org_01jz7ay6r8dd6yskkpt8rvhk8z/bookings"]
      },
      {
        role: "INBOUND",
        lines: jsonBlock(receipt)
      },
      {
        role: "COMMENT",
        lines: ["Returned OSBP JSON Receipt result. The policy required no deposit, so no money moved."]
      }
    ]),
    renderPause("2s"),
    renderGumRejectionCoda(coda),
    renderPause("5s")
  ].join("\f");
}

function renderGumRejectionCoda(coda: DemoAttempt): string {
  const price = coda.slot.price ?? coda.service.price;
  const problem = coda.validation.ok
    ? { code: "unexpected_pass", message: "Coda passed unexpectedly" }
    : coda.validation.problem;
  return renderGumCard([
    {
      role: "COMMENT",
      lines: [
        "SAME MANDATE, BIGGER ASK",
        `The user's LLM now tries to book a ${coda.service.name}`,
        `under the same ${displayMoney(coda.mandate.max_price)} mandate it used for the cleaning.`
      ]
    },
    pauseBlock("1s"),
    {
      role: "OUTBOUND",
      lines: ["osbp service.describe", ...jsonBlock(coda.serviceInput)]
    },
    pauseBlock("1s"),
    {
      role: "COMMENT",
      lines: [`Adapter -> Booking Platform: GET /v1/organizations/${coda.organization.id}/services/${coda.service.id}`]
    },
    {
      role: "INBOUND",
      lines: jsonBlock(coda.service)
    },
    pauseBlock("1s"),
    {
      role: "COMMENT",
      lines: [
        "A plain API client would just POST this booking.",
        "OSBP runs the mandate check on the server first."
      ]
    },
    {
      role: "REJECT",
      lines: [
        "MANDATE CHECK",
        "REJECT",
        `validateMandate(): ${problem.code}`,
        problemSummary(problem, price, coda.mandate.max_price)
      ]
    },
    {
      role: "COMMENT",
      lines: [
        "No booking.create reaches the platform.",
        "No write, no money.",
        "This is the line the agent cannot cross on its own."
      ]
    }
  ]);
}

type GumRole = "OPENING" | "COMMENT" | "STATE" | "OUTBOUND" | "INBOUND" | "REJECT" | "PAUSE";

function renderGumCard(blocks: Array<{ role: GumRole; lines: string[] }>): string {
  return blocks
    .map((block) => [
      block.role,
      ...block.lines
    ].join("\n"))
    .join(GUM_BLOCK_SEPARATOR);
}

function renderPause(duration: string): string {
  return renderGumCard([pauseBlock(duration)]);
}

function pauseBlock(duration: string): { role: "PAUSE"; lines: string[] } {
  return { role: "PAUSE", lines: [duration] };
}

function jsonBlock(value: unknown): string[] {
  return JSON.stringify(value, null, 2).split("\n");
}

function availabilityPath(organizationId: string, input: AvailabilityFindInput): string {
  const query = new URLSearchParams({
    serviceId: input.service_id ?? "",
    date: input.date
  });
  if (input.schedule_id) {
    query.set("scheduleId", input.schedule_id);
  }
  if (input.provider_id) {
    query.set("providerId", input.provider_id);
  }
  return `/v1/organizations/${organizationId}/availability?${query.toString()}`;
}

function renderTapeCard(title: string, lines: string[]): string {
  return [
    title,
    "",
    ...lines
  ].join("\n");
}

function selectVerticals(options: ReferenceDemoOptions): DemoVertical[] {
  if (options.launch) {
    return [DEMO_VERTICALS[0]];
  }
  if (!options.vertical) {
    return DEMO_VERTICALS;
  }

  const normalized = options.vertical.replace(/^demo_/, "");
  const vertical = DEMO_VERTICALS.find((candidate) => candidate.id === normalized);
  if (!vertical) {
    throw new Error(`Unknown demo vertical ${JSON.stringify(options.vertical)}`);
  }
  return [vertical];
}

function adapterFor(apiBaseUrl: string, organizationId: string, now: Date): SyntheticBookingAdapter {
  return new SyntheticBookingAdapter({
    apiBaseUrl,
    organizationId,
    now: () => new Date(now.getTime())
  });
}

async function prepareAttempt(
  adapter: SyntheticBookingAdapter,
  vertical: DemoVertical,
  now: Date
): Promise<DemoAttempt> {
  const organization = await expectOk(adapter.resolveOrganization());
  const serviceInput = { service_id: vertical.serviceId };
  const service = await expectOk(adapter.describeService(serviceInput));
  const availabilityInput = {
    service_id: vertical.serviceId,
    schedule_id: vertical.scheduleId,
    provider_id: vertical.providerId,
    date: demoDate(now)
  };
  const slots = await expectOk(adapter.findAvailability(availabilityInput));
  const policyInput = { service_id: vertical.serviceId };
  const policy = await expectOk(adapter.explainPolicy(policyInput));
  const slot = slots[0];
  if (!slot) {
    throw new Error(`No demo slot found for ${vertical.id}`);
  }

  const mandate = buildDemoMandate({
    id: vertical.mandateId,
    organization,
    service,
    slot,
    cap: vertical.cap,
    now
  });
  const input = buildCreateInput({
    organization,
    service,
    slot,
    mandate,
    idempotencyKey: vertical.idempotencyKey,
    customerId: vertical.customerId
  });
  const validation = validateMandate({
    mandate,
    action: "booking.create",
    organization_id: organization.id,
    service,
    slot,
    policy,
    now
  });

  return {
    organization,
    serviceInput,
    service,
    availabilityInput,
    slots,
    policy,
    policyInput,
    slot,
    mandate,
    input,
    validation
  };
}

async function confirmAndBook(
  adapter: SyntheticBookingAdapter,
  input: BookingCreateInput
): Promise<AdapterResult<Receipt>> {
  // Transparent final-confirmation handshake: the first call returns
  // requires_user_confirmation with an adapter-issued token; replay once with
  // the matching approval so the demo books while the gate stays exercised.
  const first = await adapter.createBooking(input);
  if (first.ok || first.problem.code !== "requires_user_confirmation") {
    return first;
  }
  const token = first.problem.message.match(/approval\.token="([^"]+)"/)?.[1];
  if (!token) {
    return first;
  }
  return adapter.createBooking({ ...input, approval: { confirmed: true, token } });
}

async function bookIfAuthorized(
  adapter: SyntheticBookingAdapter,
  attempt: DemoAttempt
): Promise<AdapterResult<Receipt> | undefined> {
  if (!attempt.validation.ok) {
    const rejected = await adapter.createBooking(attempt.input);
    if (rejected.ok || rejected.problem.code !== attempt.validation.problem.code) {
      throw new Error("Demo gate and booking.create returned different results");
    }
    return rejected;
  }
  return confirmAndBook(adapter, attempt.input);
}

function renderAttempt(
  lines: string[],
  intent: string,
  attempt: DemoAttempt,
  receipt: AdapterResult<Receipt> | undefined,
  colors: DemoColors
): void {
  const price = attempt.slot.price ?? attempt.service.price;
  const policySummary = policyLine(attempt.policy);

  lines.push(colors.cyan(attempt.organization.name));
  lines.push(`Intent: ${intent}`);
  renderMandateBox(lines, attempt, colors);
  lines.push("Look: service.describe + availability.find + policy.explain");
  lines.push(`  Service: ${attempt.service.name}`);
  lines.push(`  Provider: ${attempt.slot.provider_name ?? "the selected provider"}`);
  lines.push(`  Schedule: ${attempt.slot.schedule_name ?? "the selected schedule"}`);
  lines.push(`  Time: ${displayLocalTime(attempt.slot)}`);
  lines.push(`  Price: ${colors.bold(displayMoney(price))}`);
  lines.push(`  Policy: ${policySummary}`);

  if (attempt.validation.ok) {
    lines.push(`Server authorization gate: ${colors.green("PASS")}`);
    lines.push(`  ${colors.dim("validateMandate()")}: scope, time, price, and policy fit the mandate`);
    lines.push("Book: booking.create");
    if (!receipt?.ok) {
      throw new Error(`Demo booking failed with ${receipt?.problem.code ?? "missing receipt"}`);
    }
    lines.push("Receipt:");
    lines.push(`  Booked ${attempt.service.name} with ${attempt.slot.provider_name ?? "the selected provider"}.`);
    lines.push(`  ${displayLocalTime(attempt.slot)} at ${attempt.slot.schedule_name ?? attempt.organization.name}.`);
    return;
  }

  const problem = attempt.validation.problem;
  lines.push(`Server authorization gate: ${colors.red("REJECT")}`);
  lines.push(`  ${colors.dim("validateMandate()")}: ${problem.code}`);
  lines.push(`  ${problemSummary(problem, price, attempt.mandate.max_price)}`);
  lines.push("Book: blocked before merchant write");
  lines.push("Receipt: no booking created");
}

function renderMandateBox(lines: string[], attempt: DemoAttempt, colors: DemoColors): void {
  const entries = [
    "Permission slip",
    `Scope: ${attempt.organization.name}, ${attempt.service.name}`,
    `Provider: ${attempt.slot.provider_name ?? "selected provider"}`,
    `Time: ${displayLocalTime(attempt.slot)}`,
    `Price cap: ${displayMoney(attempt.mandate.max_price)}`,
    `Expires: ${attempt.mandate.expires_at}`
  ];
  const width = Math.max(...entries.map((entry) => entry.length));
  const border = `+${"-".repeat(width + 2)}+`;

  lines.push(colors.cyan("Mandate:"));
  lines.push(colors.cyan(border));
  for (const entry of entries) {
    lines.push(colors.cyan(`| ${entry.padEnd(width)} |`));
  }
  lines.push(colors.cyan(border));
}

function buildDemoMandate(input: {
  id: string;
  organization: OrganizationResponse;
  service: Service;
  slot: Slot;
  cap: Money;
  now: Date;
}): BookingMandate {
  const currency = input.cap.currency;
  return {
    id: input.id,
    expires_at: new Date(input.now.getTime() + MANDATE_EXPIRES_AFTER_MS).toISOString(),
    allowed_actions: ["booking.create"],
    organization_id: input.organization.id,
    service_ids: [input.service.id],
    provider_ids: input.slot.provider_id ? [input.slot.provider_id] : undefined,
    schedule_ids: [input.slot.schedule_id],
    earliest_start: input.slot.starts_at_local,
    latest_end: input.slot.ends_at_local ?? input.slot.starts_at_local,
    max_price: input.cap,
    allow_policy_fee: false,
    max_extra_fee: { amount_minor: 0, currency }
  };
}

function buildCreateInput(input: {
  organization: OrganizationResponse;
  service: Service;
  slot: Slot;
  mandate: BookingMandate;
  idempotencyKey: string;
  customerId: string;
}): BookingCreateInput {
  return {
    mandate: input.mandate,
    idempotency_key: input.idempotencyKey,
    service_id: input.service.id,
    schedule_id: input.slot.schedule_id,
    provider_id: input.slot.provider_id ?? `${input.organization.id}_provider`,
    date: input.slot.starts_at_local.slice(0, 10),
    time: input.slot.starts_at_local.slice(11, 16),
    customer: {
      id: input.customerId,
      phone: "+15555550100",
      display_name: "Alex Smith"
    }
  };
}

async function expectOk<T>(result: Promise<AdapterResult<T>>): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(`${resolved.problem.code}: ${resolved.problem.message}`);
  }
  return resolved.value;
}

function demoDate(now: Date): string {
  const date = new Date(now.getTime());
  date.setUTCDate(date.getUTCDate() + DEMO_DATE_OFFSET_DAYS);
  return date.toISOString().slice(0, 10);
}

function displayLocalTime(slot: Slot): string {
  return `${slot.starts_at_local.slice(0, 10)} ${slot.starts_at_local.slice(11, 16)} ${slot.schedule_timezone ?? ""}`.trim();
}

function displayTapeLocalTime(slot: Slot): string {
  return `${slot.starts_at_local.slice(5, 10)} ${slot.starts_at_local.slice(11, 16)} local`;
}

function shortOpaqueId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 18)}...` : id;
}

function displayMoney(money: Money | undefined): string {
  if (!money) {
    return "price unavailable";
  }
  return money.display ?? formatMoney(money);
}

function formatMoney(money: Money): string {
  if (money.amount_minor === undefined) {
    return money.currency;
  }
  const amount = money.amount_minor / 10 ** minorUnitExponent(money.currency);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency }).format(amount);
}

function policyLine(policy: Policy): string {
  const parts = [
    `payment ${policy.payment_requirement ?? "unknown"}`,
    `verification ${policy.verification_method ?? "unknown"}`
  ];
  if (policy.no_show_fee) {
    parts.push(`no-show fee ${displayMoney(policy.no_show_fee)}`);
  }
  if (policy.cancellation_fee) {
    parts.push(`cancellation fee ${displayMoney(policy.cancellation_fee)}`);
  }
  return parts.join(", ");
}

function shortPolicyLine(policy: Policy): string {
  const payment = policy.payment_requirement === "none"
    ? "no payment"
    : `payment ${policy.payment_requirement ?? "unknown"}`;
  const verification = policy.verification_method === "none"
    ? "no verification"
    : `verify ${policy.verification_method ?? "unknown"}`;
  return `${payment}, ${verification}`;
}

function problemSummary(problem: Problem, price: Money | undefined, cap: Money | undefined): string {
  if (problem.code === "price_exceeds_mandate") {
    return `${displayMoney(price)} is over the ${displayMoney(cap)} cap.`;
  }
  return problem.message;
}

function minorUnitExponent(currency: string): number {
  return currency.toUpperCase() === "JPY"
    ? 0
    : ["KWD", "BHD", "OMR"].includes(currency.toUpperCase())
      ? 3
      : 2;
}

function demoColors(enabled: boolean): DemoColors {
  return {
    bold: (value) => ansi(value, "1", enabled),
    green: (value) => ansi(value, "32;1", enabled),
    red: (value) => ansi(value, "31;1", enabled),
    cyan: (value) => ansi(value, "36", enabled),
    dim: (value) => ansi(value, "2", enabled)
  };
}

function ansi(value: string, code: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${value}\x1b[0m` : value;
}

export function demoVerticalIds(): string[] {
  return DEMO_VERTICALS.map((vertical) => vertical.id);
}
