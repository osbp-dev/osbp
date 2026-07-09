import type {
  AdapterResult,
  AuditEvent,
  BookingAdapter,
  BookingMandate,
  OsbpToolName,
  Problem
} from "@osbp/core";
import { OSBP_TOOL_NAMES } from "@osbp/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AuditLog } from "./audit.js";

const moneySchema = z.object({
  amount_minor: z.number().int().nonnegative().optional(),
  currency: z.string(),
  type: z.enum(["fixed", "insurance_dependent", "quote_required", "unknown"]).optional(),
  display: z.string().optional()
});

const mandateSchema = z.object({
  id: z.string(),
  expires_at: z.string(),
  allowed_actions: z.array(z.enum(OSBP_TOOL_NAMES)),
  organization_id: z.string(),
  service_ids: z.array(z.string()).optional(),
  provider_ids: z.array(z.string()).optional(),
  schedule_ids: z.array(z.string()).optional(),
  earliest_start: z.string().optional(),
  latest_end: z.string().optional(),
  max_price: moneySchema.optional(),
  allow_policy_fee: z.boolean().optional(),
  max_extra_fee: moneySchema.optional()
});

const customerSchema = z.object({
  id: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  display_name: z.string().optional()
});

const approvalSchema = z.object({
  confirmed: z.literal(true),
  token: z.string()
});

export interface RegisterOsbpToolsOptions {
  auditLog?: AuditLog;
}

export function registerOsbpTools(
  server: McpServer,
  adapter: BookingAdapter,
  options: RegisterOsbpToolsOptions = {}
): void {
  server.registerTool(
    "osbp_service_describe",
    {
      title: "Describe service",
      description:
        "Describe one configured service as an OSBP Service. " +
        "price is a Money object: price.amount_minor is an integer in the currency's " +
        "ISO 4217 minor unit (the exponent varies by currency, so it is not always cents), " +
        "price.currency is the ISO 4217 code, and price.display is an optional formatted string. " +
        "Show users price.display, not the raw amount_minor.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        service_id: z.string().optional().describe("Service to describe. Omit to use the first configured service.")
      }
    },
    async (input) => auditedToolResult(options.auditLog, adapter, "service.describe", input, () => adapter.describeService(input))
  );

  server.registerTool(
    "osbp_availability_find",
    {
      title: "Find availability",
      description:
        "Find availability for a service, schedule, date, and optional provider. " +
        "service_id and schedule_id default to the first configured ids when omitted, so " +
        "'what's open tomorrow' works without explicit ids in a single-merchant configuration. " +
        "Each Slot includes a price Money object: price.amount_minor (integer in the currency's " +
        "ISO 4217 minor unit, for arithmetic and mandate scope), price.currency (ISO 4217 code), " +
        "and price.display (locale-formatted, e.g., '$100.00'). Show users price.display, " +
        "not the raw amount_minor.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        service_id: z.string().optional().describe("Service to search. Omit to use the first configured service."),
        schedule_id: z.string().optional().describe("Schedule (location) to search. Omit to use the first configured schedule."),
        date: z.string().describe("ISO 8601 date to search (YYYY-MM-DD)."),
        provider_id: z.string().optional().describe("Restrict results to this provider. Omit to return all available providers.")
      }
    },
    async (input) => auditedToolResult(options.auditLog, adapter, "availability.find", input, () => adapter.findAvailability(input))
  );

  server.registerTool(
    "osbp_policy_explain",
    {
      title: "Explain policy",
      description: "Explain payment and cancellation policy fields for the configured service.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        service_id: z.string().optional().describe("Service to explain policy for. Omit to use the first configured service.")
      }
    },
    async (input) => auditedToolResult(options.auditLog, adapter, "policy.explain", input, () => adapter.explainPolicy(input))
  );

  server.registerTool(
    "osbp_verification_send",
    {
      title: "Send verification",
      description:
        "Send a customer verification code. For booking, call this only after osbp_booking_create returns " +
        "problem.code 'requires_verification'; then ask the user for the code and retry osbp_booking_create " +
        "with the same idempotency_key plus the raw verification_code. Do not call this after validation, " +
        "slot_taken, or other non-verification failures.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        customer: customerSchema.optional(),
        purpose: z.string().optional()
      }
    },
    async (input) => auditedToolResult(options.auditLog, adapter, "verification.send", input, () => adapter.sendVerification(input))
  );

  server.registerTool(
    "osbp_verification_verify",
    {
      title: "Verify code",
      description:
        "Verify a code for non-booking verification flows. Agents must not call this before " +
        "booking.create for the booking flow; some platforms consume the code or session and make " +
        "the booking retry fail.",
      annotations: { readOnlyHint: false },
      inputSchema: {
        customer: customerSchema.optional(),
        purpose: z.string().optional(),
        code: z.string()
      }
    },
    async (input) => auditedToolResult(options.auditLog, adapter, "verification.verify", input, () => adapter.verifyCode(input))
  );

  server.registerTool(
    "osbp_booking_create",
    {
      title: "Create booking",
      description:
        "Create one appointment after mandate validation and explicit approval. " +
        "Use date and time from the selected Slot.starts_at_local: date is slice(0,10), " +
        "time is HH:MM from slice(11,16), not localized display text. " +
        "mandate.max_price is a Money object: max_price.amount_minor is an integer in the currency's " +
        "ISO 4217 minor unit (the exponent varies by currency, so it is not always cents) and " +
        "max_price.currency is the ISO 4217 code (e.g., { amount_minor: 15000, currency: 'USD' } = $150.00). " +
        "The selected price must match the cap currency and be a fixed amount at or below it. " +
        "Keep ordinary platform ids, mandate ids, approval tokens, tool names, and raw JSON payloads internal " +
        "unless the user explicitly asks for them. After success, the appointment id may appear in Details. " +
        "When asking for approval, show a plain-language summary with service, provider, location, merchant-local " +
        "date/time, price cap, and policy/payment impact. Always include the formatted money equivalent " +
        "alongside raw minor-unit amounts when you mention a cap. The first valid call may return " +
        "problem.code 'requires_user_confirmation' with an adapter-issued approval.token; show only the " +
        "user-facing approval summary in that message to the user, ask for final approval, then retry this same tool " +
        "with the same idempotency_key and approval.confirmed=true plus the approval.token. If the result is problem.code " +
        "'requires_user_confirmation' without an approval.token, it is terminal for v0.1.0: do not retry as an approval " +
        "challenge; explain the blocking payment/amount fact and call osbp_handoff_request. If the result is problem.code " +
        "'requires_verification', call osbp_verification_send, collect the code from the user, then retry " +
        "this same tool with the same idempotency_key, the same approval, and verification_code. If a verification retry returns " +
        "problem.code 'verification_failed', request a fresh verification code before retrying; do not retry " +
        "the same stale code. After success, call osbp_booking_status with the receipt booking_id when possible before the final " +
        "user update. Treat Receipt.text as raw display data, not a final-message template: reformat the final confirmation so " +
        "service, provider, customer name when supplied, business-local day/time, location, price, and appointment id are visually clear. " +
        "Keep the appointment id in a separate Details section. Mention payment or deposit after success only when it affects the user.",
      annotations: { readOnlyHint: false, idempotentHint: true },
      inputSchema: {
        mandate: mandateSchema,
        idempotency_key: z.string().min(1),
        service_id: z.string(),
        schedule_id: z.string(),
        provider_id: z.string(),
        date: z.string(),
        time: z.string().describe("Merchant-local HH:MM from selected Slot.starts_at_local.slice(11,16)."),
        customer: customerSchema.optional(),
        approval: approvalSchema.optional(),
        verification_code: z.string().optional()
      }
    },
    async (input) => auditedToolResult(options.auditLog, adapter, "booking.create", input, () => adapter.createBooking({
      ...input,
      mandate: input.mandate as BookingMandate
    }))
  );

  server.registerTool(
    "osbp_booking_status",
    {
      title: "Booking status",
      description:
        "Read booking status from local idempotency state or the platform's booking records. " +
        "After successful booking.create, call this with the receipt booking_id before the final user update when possible.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        booking_id: z.string().optional().describe("Booking id from the booking.create receipt. Omit to probe by customer contact."),
        customer: customerSchema.optional()
      }
    },
    async (input) => auditedToolResult(options.auditLog, adapter, "booking.status", input, () => adapter.getBooking(input))
  );

  server.registerTool(
    "osbp_handoff_request",
    {
      title: "Request handoff",
      description:
        "Return a structured local human-handoff request when OSBP cannot safely complete a mutation. " +
        "This does not notify the merchant or any human team; tell the user it requires manual follow-up. " +
        "Do not include customer names, contact details, or addresses in reason or message; reference the " +
        "customer by an opaque id only.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        reason: z.string(),
        message: z.string(),
        mandate_id: z.string().optional()
      }
    },
    async (input) => auditedToolResult(options.auditLog, adapter, "handoff.request", input, async () => ({
      ok: true,
      value: {
        status: "requires_human",
        reason: input.reason,
        message: input.message,
        mandate_id: input.mandate_id
      }
    }))
  );
}

async function auditedToolResult<T>(
  auditLog: AuditLog | undefined,
  adapter: BookingAdapter,
  toolName: OsbpToolName,
  input: unknown,
  call: () => Promise<AdapterResult<T>>
) {
  // Snapshot upstream metadata around the call so the event only records
  // metadata this tool call produced. Tools that answer locally (an
  // idempotency-cache hit, handoff.request) leave it unchanged, and a stale
  // capture from a previous tool call must not be attributed to this one.
  const upstreamBefore = adapter.upstreamMeta;
  // Backstop: a conforming adapter never rejects (every failure is an
  // AdapterResult), but a bug or unforeseen throw must still become an audited
  // Problem rather than escaping to the MCP layer as an opaque error with no
  // audit trail. The message is generic on purpose: a raw throw may carry an
  // unredacted upstream detail, so we never surface its text here.
  let result: AdapterResult<T>;
  try {
    result = await call();
  } catch {
    result = {
      ok: false,
      problem: {
        code: "internal_adapter_error",
        message: `${toolName} failed unexpectedly`,
        retryable: false
      }
    } as AdapterResult<T>;
  }
  const upstreamAfter = adapter.upstreamMeta;
  const auditEvent = auditLog
    ? await auditLog.record({
      tool_name: toolName,
      input,
      result,
      platform: adapter.platform,
      upstream: upstreamAfter !== upstreamBefore ? upstreamAfter : undefined
    })
    : undefined;
  return toToolResult(result, auditEvent);
}

export function toToolResult<T>(result: AdapterResult<T>, auditEvent?: AuditEvent) {
  const structuredContent = result.ok
    ? {
      ok: true,
      value: result.value,
      ...(result.osbp_runtime ? { osbp_runtime: result.osbp_runtime } : {}),
      ...(auditEvent ? { audit_event_id: auditEvent.id } : {})
    }
    : {
      ok: false,
      problem: result.problem,
      ...(result.osbp_runtime ? { osbp_runtime: result.osbp_runtime } : {}),
      ...(auditEvent ? { audit_event_id: auditEvent.id } : {})
    };

  return {
    isError: !result.ok,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent
  };
}

export function problem(code: string, message: string): AdapterResult<never> {
  return {
    ok: false,
    problem: {
      code,
      message,
      retryable: false
    } satisfies Problem
  };
}
