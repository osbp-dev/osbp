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
import { readFileSync, readdirSync } from "node:fs";
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
