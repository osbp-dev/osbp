#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SyntheticBookingAdapter, startSyntheticBookingServer } from "../packages/reference-backend/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const divider = "-".repeat(72);
const colorEnabled = shouldUseColor();
const ansi = {
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
  reset: "\u001b[0m"
};
const style = {
  bold: (text) => color(ansi.bold, text),
  dim: (text) => color(ansi.dim, text),
  cyan: (text) => color(ansi.cyan, text),
  green: (text) => color(ansi.green, text),
  yellow: (text) => color(ansi.yellow, text),
  magenta: (text) => color(ansi.magenta, text)
};
const defaultTraceFiles = [
  "traces/v0.1.0/reference-dental-booking-create.json",
  "traces/v0.1.0/reference-dental-fail-closed-guardrails.json",
  "traces/v0.1.0/reference-notary-remote-service.json",
  "traces/v0.1.0/reference-auto-timezone-currency.json",
  "traces/v0.1.0/reference-dental-idempotent-retry.json"
];
const requestedTraceFiles = process.argv.slice(2);
const tracePaths = (requestedTraceFiles.length > 0 ? requestedTraceFiles : defaultTraceFiles)
  .map((traceFile) => resolve(root, traceFile));

for (const [index, tracePath] of tracePaths.entries()) {
  if (index > 0) {
    console.log("");
    console.log(style.dim(divider));
    console.log("");
  }
  const trace = JSON.parse(readFileSync(tracePath, "utf8"));
  if (Array.isArray(trace.steps)) {
    await replayTrace(tracePath, trace);
  } else if (Array.isArray(trace.tool_calls)) {
    validateRecordedTrace(tracePath, trace);
  } else {
    throw new Error(`${relativeTracePath(tracePath)} is not a supported OSBP trace shape`);
  }
}

async function replayTrace(tracePath, trace) {
  const server = await startSyntheticBookingServer();
  try {
    const adapter = new SyntheticBookingAdapter({
      apiBaseUrl: server.url,
      organizationId: trace.scenario.organization_id,
      now: () => new Date(trace.clock)
    });

    const guardrails = [];
    let replayed = 0;
    for (const step of trace.steps) {
      const actual = await callTool(adapter, step.tool, step.input);
      assertSubset(actual, step.result, step.tool);
      for (const absentPath of step.assert_absent ?? []) {
        assert.equal(readPath(actual, absentPath), undefined, `${step.tool}.${absentPath}: expected field to be absent`);
      }
      if (step.result?.ok === false) {
        guardrails.push(actual.problem?.code ?? "unknown_problem");
        if (step.platform_write === false) {
          assert.equal(actual.ok, false, `${step.tool}: expected no platform write guardrail`);
        }
      }
      replayed += 1;
    }

    const noWriteSuffix = trace.steps.some((step) => step.result?.ok === false && step.platform_write === false)
      ? ", no platform write"
      : "";
    const guardrail = guardrails.length > 0 ? `${guardrails.join(", ")}${noWriteSuffix}` : "none";

    console.log(`${style.dim("Runner:")} ${style.dim("scripts/run-reference-trace.mjs")}`);
    console.log(`${style.bold("Scenario:")} ${trace.scenario.title ?? trace.scenario.intent ?? trace.name}`);
    console.log("");
    console.log(`${style.bold("User Request:")} ${summarizeUserRequest(trace)}`);
    console.log("");
    console.log(`${style.cyan("Booking Mandate:")} ${summarizeBookingMandates(trace)}`);
    console.log("");
    console.log(`${style.green("Result:")} replayed ${replayed} step(s)`);
    console.log(`${guardrail === "none" ? style.green("Guardrail triggered:") : style.yellow("Guardrail triggered:")} ${guardrail}`);
    if (trace.idempotency?.summary) {
      console.log(`${style.magenta("Idempotency:")} ${trace.idempotency.summary}`);
    }
    console.log(`${style.dim("Trace file:")} ${relativeTracePath(tracePath)}`);
  } finally {
    await server.close();
  }
}

function validateRecordedTrace(tracePath, trace) {
  assert.ok(trace.trace_id, `${relativeTracePath(tracePath)}: missing trace_id`);
  assert.ok(trace.user_request, `${relativeTracePath(tracePath)}: missing user_request`);
  assert.ok(trace.mandate, `${relativeTracePath(tracePath)}: missing mandate`);
  assert.ok(trace.tool_calls.length > 0, `${relativeTracePath(tracePath)}: expected at least one tool call`);

  for (const [index, call] of trace.tool_calls.entries()) {
    assert.ok(call.tool, `${relativeTracePath(tracePath)}.tool_calls[${index}]: missing tool`);
    assert.ok(call.input !== undefined, `${relativeTracePath(tracePath)}.tool_calls[${index}]: missing input`);
    assert.ok(call.output !== undefined, `${relativeTracePath(tracePath)}.tool_calls[${index}]: missing output`);
  }

  console.log(`${style.dim("Runner:")} ${style.dim("scripts/run-reference-trace.mjs")}`);
  console.log(`${style.bold("Scenario:")} ${summarizeScenario(trace)}`);
  console.log("");
  console.log(`${style.bold("User Request:")} ${summarizeUserRequest(trace)}`);
  console.log("");
  console.log(`${style.cyan("Booking Mandate:")} ${summarizeBookingMandates(trace)}`);
  console.log("");
  console.log(`${style.green("Result:")} recorded ${trace.tool_calls.length} tool call(s)`);
  console.log(`${style.green("Guardrail triggered:")} none`);
  console.log(`${style.dim("Trace file:")} ${relativeTracePath(tracePath)}`);
}

function shouldUseColor() {
  if (process.env.OSBP_TRACE_COLOR === "1") {
    return true;
  }
  if (process.env.NO_COLOR || process.env.OSBP_TRACE_COLOR === "0") {
    return false;
  }
  return Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");
}

function color(code, text) {
  return colorEnabled ? `${code}${text}${ansi.reset}` : text;
}

function summarizeScenario(trace) {
  if (trace.scenario?.title || trace.scenario?.intent || trace.name) {
    return trace.scenario.title ?? trace.scenario.intent ?? trace.name;
  }
  return trace.trace_id ?? "Recorded OSBP trace";
}

function summarizeUserRequest(trace) {
  return trace.scenario?.user_request ?? trace.user_request ?? trace.scenario?.intent ?? "not provided";
}

async function createBookingWithApproval(adapter, input) {
  // Transparent final-confirmation handshake so replayed traces book through
  // the same gate a real adapter enforces, without threading a dynamic token
  // through the static trace fixtures.
  const first = await adapter.createBooking(input);
  if (first.ok || first.problem?.code !== "requires_user_confirmation") {
    return first;
  }
  const token = first.problem.message?.match(/approval\.token="([^"]+)"/)?.[1];
  if (!token) {
    return first;
  }
  return adapter.createBooking({ ...input, approval: { confirmed: true, token } });
}

async function callTool(adapter, tool, input) {
  switch (tool) {
    case "service.describe":
      return adapter.describeService(input);
    case "availability.find":
      return adapter.findAvailability(input);
    case "policy.explain":
      return adapter.explainPolicy(input);
    case "booking.create":
      return createBookingWithApproval(adapter, input);
    case "booking.status":
      return adapter.getBooking(input);
    default:
      throw new Error(`Unsupported trace tool ${tool}`);
  }
}

function assertSubset(actual, expected, path) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array`);
    assert.equal(actual.length, expected.length, `${path}: array length drift`);
    expected.forEach((item, index) => assertSubset(actual[index], item, `${path}[${index}]`));
    return;
  }

  if (expected !== null && typeof expected === "object") {
    assert.ok(actual !== null && typeof actual === "object", `${path}: expected an object`);
    for (const [key, value] of Object.entries(expected)) {
      assertSubset(actual[key], value, `${path}.${key}`);
    }
    return;
  }

  assert.deepEqual(actual, expected, `${path}: value drift`);
}

function summarizeBookingMandates(trace) {
  const mandates = [];
  const seen = new Set();
  if (trace.mandate) {
    const key = trace.mandate.id ?? JSON.stringify(trace.mandate);
    seen.add(key);
    mandates.push(trace.mandate);
  }
  for (const step of trace.steps ?? []) {
    if (step.tool !== "booking.create" || !step.input?.mandate) {
      continue;
    }
    const mandate = step.input.mandate;
    const key = mandate.id ?? JSON.stringify(mandate);
    if (!seen.has(key)) {
      seen.add(key);
      mandates.push(mandate);
    }
  }

  if (mandates.length === 0) {
    return "none in trace";
  }

  const summaries = mandates.map(summarizeMandate);
  if (summaries.length === 1) {
    return summaries[0];
  }

  return [
    `${summaries.length} mandates`,
    ...summaries.map((summary, index) => `Mandate ${index + 1}: ${summary}`)
  ].join("\n");
}

function summarizeMandate(mandate) {
  const actions = mandate.allowed_actions?.join(",") || "no actions";
  const parts = [`${mandate.id ?? "unnamed"} allows ${actions}`];
  appendScope(parts, "service", mandate.service_ids);
  appendScope(parts, "provider", mandate.provider_ids);
  appendScope(parts, "schedule", mandate.schedule_ids);
  if (mandate.earliest_start || mandate.latest_end) {
    parts.push(`window ${mandate.earliest_start ?? "open"}..${mandate.latest_end ?? "open"}`);
  }
  const maxPrice = formatMoney(mandate.max_price);
  if (maxPrice) {
    parts.push(`max ${maxPrice}`);
  }
  return parts.join("; ");
}

function appendScope(parts, singular, values) {
  if (!values) {
    return;
  }
  const label = values.length === 1 ? singular : `${singular}s`;
  parts.push(`${label} ${values.join(",")}`);
}

function formatMoney(money) {
  if (!money?.currency) {
    return undefined;
  }
  if (money.amount_minor === undefined) {
    return money.currency;
  }
  const amount = money.amount_minor / (10 ** currencyExponent(money.currency));
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: money.currency }).format(amount);
  } catch {
    return `${money.amount_minor} ${money.currency} minor units`;
  }
}

function currencyExponent(currency) {
  if (["JPY", "KRW"].includes(currency)) {
    return 0;
  }
  if (["BHD", "KWD", "OMR", "TND"].includes(currency)) {
    return 3;
  }
  return 2;
}

function readPath(value, path) {
  return path.split(".").reduce((cursor, segment) => {
    if (cursor === undefined || cursor === null) {
      return undefined;
    }
    const key = /^\d+$/.test(segment) ? Number(segment) : segment;
    return cursor[key];
  }, value);
}

function relativeTracePath(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
