import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireApproval, type PendingApproval } from "./approval.js";

const base = () => ({
  payloadHash: "hash_1",
  summary: "Book Short Haircut for $45.00 on 2026-07-07 at 09:00.",
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
    assert.match(result.ok ? "" : result.problem.message, /Book Short Haircut/);
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
});
