import type { BookingApproval, Problem } from "./index.js";

export const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface PendingApproval {
  token: string;
  summary: string;
  expiresAt: number;
}

export type ApprovalGateResult =
  | { ok: true; approval: BookingApproval }
  | { ok: false; problem: Problem };

export interface RequireApprovalInput {
  approval: BookingApproval | undefined;
  payloadHash: string;
  summary: string;
  store: Map<string, PendingApproval>;
  now: number;
  newToken: () => string;
  ttlMs?: number;
}

// Adapter-side final-confirmation gate, shared by every OSBP adapter so the
// neutral reference backend demonstrates the same behavior a real one must.
//
// The FIRST booking.create for a logical attempt (no matching, unexpired,
// confirmed token) returns `requires_user_confirmation` with an adapter-issued
// token and the exact summary, and does NOT create a booking. Only a retry with
// the same payload (same payloadHash), `approval.confirmed === true`, and the
// matching token proceeds. This is a v0.1.0 brake: the token still flows
// through the agent, so it cannot prove a human approved the summary. A
// production deployment moves final confirmation to a host/server primitive
// outside the agent's unilateral control. `approval` (and `verification_code`)
// MUST be excluded from `payloadHash` so the first call and the approved retry
// resolve to the same pending entry and the same logical booking attempt.
export function requireApproval(input: RequireApprovalInput): ApprovalGateResult {
  const { approval, payloadHash, summary, store, now, newToken } = input;
  const ttlMs = input.ttlMs ?? APPROVAL_TOKEN_TTL_MS;

  const pending = store.get(payloadHash);
  if (pending && pending.expiresAt > now && approval?.confirmed === true && approval.token === pending.token) {
    return { ok: true, approval };
  }

  if (pending && pending.expiresAt <= now) {
    store.delete(payloadHash);
  }

  // Reuse an existing unexpired challenge so repeated unconfirmed retries see a
  // stable token, and mint a fresh one otherwise.
  const active = store.get(payloadHash) ?? {
    token: newToken(),
    summary,
    expiresAt: now + ttlMs
  };
  store.set(payloadHash, active);

  return {
    ok: false,
    problem: {
      code: "requires_user_confirmation",
      message:
        "Final user approval is required before booking. Show this exact summary to the user: " +
        `${active.summary} If the user approves, retry booking.create with ` +
        `approval.confirmed=true and approval.token=${JSON.stringify(active.token)}.`,
      retryable: true
    }
  };
}
