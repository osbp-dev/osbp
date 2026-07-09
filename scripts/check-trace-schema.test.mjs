// Regression guard: every published golden trace must satisfy the published
// JSON Schemas. This catches the drift class where a reject step carried only
// { code } while problem.schema.json requires [code, message] -- the trace
// runner's subset-assert is structurally blind to a missing required field, so
// without this check the schemas are unenforced documentation.
//
// Dependency-free on purpose: it reads `required` and the basic property types
// straight from the published schemas, so the public repo keeps its minimal
// supply chain (no ajv) while still proving the schemas and traces agree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schemaDir = join(root, "schemas/v0.1.0");
const tracesDir = join(root, "traces/v0.1.0");

const loadJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const problemSchema = loadJson(join(schemaDir, "problem.schema.json"));

const typeOfJson = (value) => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

function assertRequiredAndTypes(object, schema, where) {
  assert.equal(typeof object, "object", `${where} must be an object`);
  for (const key of schema.required ?? []) {
    assert.ok(object[key] !== undefined, `${where}: missing schema-required "${key}"`);
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (object[key] === undefined || spec === true || !spec.type) continue;
    assert.equal(typeOfJson(object[key]), spec.type, `${where}.${key} must be ${spec.type}`);
  }
}

const traceFiles = readdirSync(tracesDir).filter((file) => file.endsWith(".json"));

test("every published schema file is present and well-formed", () => {
  // Coverage guard: the conformance kit validates real payloads against each of
  // these published schemas, so this asserts the file set is intact (none added
  // or removed unnoticed) and each parses as a JSON Schema. The separate
  // schema-vs-Zod regeneration check runs in the full development workspace.
  const expected = [
    "booking-mandate.schema.json",
    "problem.schema.json",
    "result-envelope.schema.json",
    "tool-inputs.schema.json"
  ];
  const present = readdirSync(schemaDir).filter((file) => file.endsWith(".schema.json")).sort();
  assert.deepEqual(present, [...expected].sort(), "published schema file set changed; update the conformance kit and this guard");
  for (const file of present) {
    const schema = loadJson(join(schemaDir, file));
    assert.equal(typeof schema, "object", `${file} must parse to a JSON object`);
    assert.ok(
      schema.$schema || schema.type || schema.$defs || schema.properties || schema.oneOf,
      `${file} must look like a JSON Schema`
    );
  }
});

test("published schemas keep Problem.message required", () => {
  // Guards the contract this whole check rests on. If someone relaxes the
  // schema, this fails loudly instead of silently weakening every trace.
  assert.ok(
    (problemSchema.required ?? []).includes("message"),
    "problem.schema.json must keep `message` required"
  );
});

test("every golden trace reject step carries a schema-valid Problem", () => {
  assert.ok(traceFiles.length > 0, "expected at least one golden trace");
  for (const file of traceFiles) {
    const trace = loadJson(join(tracesDir, file));
    for (const step of trace.steps ?? []) {
      const result = step.result;
      if (!result || typeof result !== "object") continue;
      const label = `${file} step ${step.step}`;
      if (result.ok === false) {
        assert.ok(result.problem, `${label}: ok:false must carry a problem`);
        assertRequiredAndTypes(result.problem, problemSchema, `${label} problem`);
      } else if (result.ok === true) {
        assert.ok("value" in result, `${label}: ok:true must carry a value`);
      }
    }
  }
});

test("every successful booking.create trace receipt carries required Receipt fields", () => {
  assert.ok(traceFiles.length > 0, "expected at least one golden trace");
  for (const file of traceFiles) {
    const trace = loadJson(join(tracesDir, file));
    for (const [index, call] of bookingCreateCalls(trace).entries()) {
      const receipt = receiptValue(call);
      if (!receipt) {
        continue;
      }
      const label = `${file} booking.create[${index}] receipt`;
      assert.equal(typeof receipt.id, "string", `${label}.id must be a string`);
      assert.equal(typeof receipt.text, "string", `${label}.text must be a string`);
      assert.ok(receipt.text.length > 0, `${label}.text must not be empty`);
    }
  }
});

test("redacted live trace uses the configured-customer alias documented by the generator", () => {
  const liveTracePath = join(tracesDir, ["open", "ing", "s-create.json"].join(""));
  if (!existsSync(liveTracePath)) {
    return;
  }
  const trace = loadJson(liveTracePath);
  const serialized = JSON.stringify(trace);
  assert.ok(
    serialized.includes("customer_configured"),
    "live trace should use the configured customer alias"
  );
  assert.ok(
    !serialized.includes("test_customer") && !serialized.includes("customer_1"),
    "live trace should not use stale generated customer aliases"
  );
});

test("successful golden traces show the approval preflight before the first create", () => {
  assert.ok(traceFiles.length > 0, "expected at least one golden trace");
  for (const file of traceFiles) {
    const trace = loadJson(join(tracesDir, file));
    const creates = bookingCreateCalls(trace);
    const firstSuccessIndex = creates.findIndex((call) => isSuccessfulCreate(call));
    if (firstSuccessIndex === -1) {
      continue;
    }

    const preflightIndex = creates.findIndex((call, index) => (
      index < firstSuccessIndex &&
      call.input?.approval === undefined &&
      problemCode(call) === "requires_user_confirmation"
    ));
    assert.notEqual(
      preflightIndex,
      -1,
      `${file}: first successful booking.create must be preceded by a requires_user_confirmation preflight`
    );

    const firstSuccess = creates[firstSuccessIndex];
    assert.equal(firstSuccess.input?.approval?.confirmed, true, `${file}: first successful booking.create must carry approval`);
    assert.equal(
      firstSuccess.input?.approval?.token,
      "[redacted]",
      `${file}: approval token in published traces must be redacted`
    );
  }
});

function bookingCreateCalls(trace) {
  if (Array.isArray(trace.steps)) {
    return trace.steps
      .filter((step) => step.tool === "booking.create")
      .map((step) => ({
        input: step.input,
        output: step.result
      }));
  }

  return (trace.tool_calls ?? [])
    .filter((call) => call.tool === "osbp_booking_create" || call.tool === "booking.create")
    .map((call) => ({
      input: call.input,
      output: call.output
    }));
}

function problemCode(call) {
  return call.output?.problem?.code;
}

function isSuccessfulCreate(call) {
  return call.output?.ok === true || call.output?.receipt !== undefined;
}

function receiptValue(call) {
  if (call.output?.ok === true) {
    return call.output.value;
  }
  return call.output?.receipt;
}
