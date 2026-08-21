import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireApproval, type PendingApproval } from "./approval.js";

const base = () => ({
  payloadHash: "hash_1",
  summary: "Book Initial Consultation for $45.00 on 2026-07-07 at 09:00.",
  store: new Map<string, PendingApproval>(),
  now: 1_000_000,
  newToken: () => "tok_fixed"
});

describe("requireApproval", () => {
  it("issues a token and requires confirmation on the first call", () => {
    const result = requireApproval({ ...base(), approval: undefined });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.problem.code, "requires_user_confirmation");
    assert.match(result.ok ? "" : result.problem.message, /approval\.token="tok_fixed"/);
    assert.match(result.ok ? "" : result.problem.message, /Book Initial Consultation/);
    assert.match(result.ok ? "" : result.problem.message, /Agent retry instruction:/);
    assert.doesNotMatch(result.ok ? "" : result.problem.message, /booking\.create/);
  });

  it("admits a retry with the matching confirmed token and same payload", () => {
    const store = new Map<string, PendingApproval>();
    const first = requireApproval({ ...base(), store, approval: undefined });
    assert.equal(first.ok, false);
    const result = requireApproval({ ...base(), store, approval: { confirmed: true, token: "tok_fixed" } });
    assert.equal(result.ok, true);
  });

  it("re-challenges a retry that supplies the wrong token", () => {
    const store = new Map<string, PendingApproval>();
    requireApproval({ ...base(), store, approval: undefined });
    const result = requireApproval({ ...base(), store, approval: { confirmed: true, token: "tok_wrong" } });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.problem.code, "requires_user_confirmation");
  });

  it("re-challenges a confirmed retry when resolved summary facts changed", () => {
    const store = new Map<string, PendingApproval>();
    requireApproval({ ...base(), store, approval: undefined });

    const result = requireApproval({
      ...base(),
      store,
      summary: "Book Initial Consultation for $50.00 on 2026-07-07 at 09:00.",
      approval: { confirmed: true, token: "tok_fixed" },
      newToken: () => "tok_changed"
    });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? "" : result.problem.code, "requires_user_confirmation");
    assert.match(result.ok ? "" : result.problem.message, /\$50\.00/);
    assert.match(result.ok ? "" : result.problem.message, /approval\.token="tok_changed"/);
  });

  it("re-challenges after the token has expired", () => {
    const store = new Map<string, PendingApproval>();
    requireApproval({ ...base(), store, approval: undefined, ttlMs: 1000 });
    const result = requireApproval({
      ...base(),
      store,
      approval: { confirmed: true, token: "tok_fixed" },
      now: 1_002_000,
      ttlMs: 1000
    });
    assert.equal(result.ok, false);
  });

  it("sweeps expired approval entries while checking a new attempt", () => {
    const store = new Map<string, PendingApproval>([
      ["old_hash", { token: "tok_old", summary: "Old booking.", expiresAt: 1 }],
      ["active_hash", { token: "tok_active", summary: "Active booking.", expiresAt: 2_000_000 }]
    ]);

    const result = requireApproval({
      ...base(),
      payloadHash: "new_hash",
      store,
      approval: undefined,
      now: 1_000_000
    });

    assert.equal(result.ok, false);
    assert.equal(store.has("old_hash"), false);
    assert.equal(store.has("active_hash"), true);
    assert.equal(store.has("new_hash"), true);
  });
});
