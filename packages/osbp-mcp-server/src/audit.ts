import type { AdapterResult, AuditEvent, OsbpToolName, PlatformIdentity, Problem, UpstreamMeta } from "@osbp/core";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface AuditToolCallInput<T> {
  tool_name: OsbpToolName;
  input: unknown;
  result: AdapterResult<T>;
  platform?: PlatformIdentity;
  upstream?: UpstreamMeta;
}

export interface AuditLog {
  record<T>(input: AuditToolCallInput<T>): Promise<AuditEvent>;
}

export class JsonlAuditLog implements AuditLog {
  constructor(private readonly path: string) {}

  async record<T>(input: AuditToolCallInput<T>): Promise<AuditEvent> {
    const event = createAuditEvent(input);
    // Audit events carry capability-shaped values (mandate ids, booking ids, and
    // upstream context). Create the directory and file owner-only so a process
    // under a permissive umask cannot read them by default. The mode applies on
    // creation; a pre-existing log keeps its current mode.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    return event;
  }
}

export function defaultAuditLogPath(
  env: Record<string, string | undefined> = process.env,
  baseDir: string = process.cwd()
): string {
  return env.OSBP_AUDIT_LOG_PATH ?? resolve(baseDir, ".osbp/audit/events.jsonl");
}

export function createAuditEvent<T>(input: AuditToolCallInput<T>): AuditEvent {
  const redactedInput = redact(input.input);
  const redactedResult = redactResult(input.result);

  return {
    id: `aud_${randomUUID()}`,
    mandate_id: mandateIdFrom(redactedInput),
    tool_name: input.tool_name,
    created_at: new Date().toISOString(),
    source: "osbp-local-mcp",
    // platform/upstream carry no customer data by construction: UpstreamMeta
    // is method + redacted path + response headers only.
    platform: input.platform,
    upstream: input.upstream,
    input: redactedInput,
    result: redactedResult,
    input_hash: hashJson(redactedInput),
    result_hash: hashJson(redactedResult)
  };
}

function mandateIdFrom(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return undefined;
  }

  const mandate = input.mandate;
  return isRecord(mandate) && typeof mandate.id === "string" ? mandate.id : undefined;
}

function redactResult<T>(result: AdapterResult<T>): unknown {
  if (result.ok) {
    return {
      ok: true,
      value: redact(result.value)
    };
  }

  return {
    ok: false,
    problem: redactProblem(result.problem)
  };
}

// Problem.code is the closed OSBP protocol enum (e.g. "requires_verification",
// "rate_limited"), not customer data, so it is preserved for debuggability. The
// generic redactor blanks every key named "code" because VerificationVerifyInput
// carries the raw OTP under that exact key; here we know the key is the enum and
// restore it. message/retryable still flow through the generic redactor.
function redactProblem(problem: Problem): unknown {
  const redacted = redact(problem);
  return isRecord(redacted) ? { ...redacted, code: problem.code } : redacted;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (["phone", "email", "verification_code", "code"].includes(key)) {
        return [key, "[redacted]"];
      }

      return [key, redact(entry)];
    })
  );
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
