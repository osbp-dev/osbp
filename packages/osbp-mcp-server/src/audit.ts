import type { AdapterResult, AuditEvent, OsbpToolName, PlatformIdentity, Problem, UpstreamMeta } from "@osbp/core";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
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
  const configured = env.OSBP_AUDIT_LOG_PATH;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(baseDir, configured);
  }
  return resolve(baseDir, ".osbp/audit/events.jsonl");
}

export function createAuditEvent<T>(input: AuditToolCallInput<T>): AuditEvent {
  const secrets = collectSensitiveStrings(input.input);
  const redactedInput = redact(input.input, secrets);
  const redactedResult = redactResult(input.result, secrets);

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
  if (isRecord(mandate) && typeof mandate.id === "string") {
    return mandate.id;
  }

  return typeof input.mandate_id === "string" ? input.mandate_id : undefined;
}

function redactResult<T>(result: AdapterResult<T>, secrets: ReadonlySet<string>): unknown {
  if (result.ok) {
    return {
      ok: true,
      value: redact(result.value, secrets)
    };
  }

  return {
    ok: false,
    problem: redactProblem(result.problem, secrets)
  };
}

// Problem.code is the closed OSBP protocol enum (e.g. "requires_verification",
// "rate_limited"), not customer data, so it is preserved for debuggability. The
// generic redactor blanks every key named "code" because VerificationVerifyInput
// carries the raw OTP under that exact key; here we know the key is the enum and
// restore it. message/retryable still flow through the generic redactor.
function redactProblem(problem: Problem, secrets: ReadonlySet<string>): unknown {
  const redacted = redact(problem, secrets);
  if (!isRecord(redacted)) {
    return redacted;
  }

  return {
    ...redacted,
    code: problem.code,
    message:
      typeof problem.message === "string" ? redactSensitiveText(problem.message, secrets) : redacted.message
  };
}

const REDACTED = "[redacted]";
const SENSITIVE_KEYS = new Set([
  "phone",
  "email",
  "given_name",
  "givenName",
  "family_name",
  "familyName",
  "display_name",
  "displayName",
  "verification_code",
  "provider_image_url",
  "code",
  "token",
  "approval_token"
]);

function redact(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, secrets));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (SENSITIVE_KEYS.has(key)) {
        return [key, REDACTED];
      }

      return [key, redact(entry, secrets)];
    })
  );
}

function collectSensitiveStrings(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectSensitiveStrings(entry, result);
    }
    return result;
  }

  if (!isRecord(value)) {
    return result;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key) && typeof entry === "string" && entry.length > 0) {
      result.add(entry);
    }
    collectSensitiveStrings(entry, result);
  }
  return result;
}

function redactSensitiveText(value: string, secrets: ReadonlySet<string>): string {
  let redacted = value
    .replace(/approval\.token="[^"]*"/g, `approval.token="${REDACTED}"`)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
    .replace(/\+?\d[\d\s().-]{5,}\d/g, (match) => {
      const digits = match.replace(/\D/g, "");
      const phoneish = match.trim().startsWith("+") || digits.length >= 10 || /[()]/.test(match);
      return digits.length >= 7 && phoneish ? REDACTED : match;
    });

  for (const secret of secrets) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
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
