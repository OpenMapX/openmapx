import {
  ACTIVE_REQUEST_STATES,
  acceptsCaseDecision,
  acceptsManualIdentityVerification,
  acceptsSelfServiceExport,
  acceptsTaskResolution,
  acceptsWithdrawal,
  canExtendDeadline,
  isActiveRequestState,
  isTerminalRequestState,
  isValidRequestTransition,
  REQUEST_STATES,
  type RequestState,
  TERMINAL_REQUEST_STATES,
} from "@openmapx/core/privacy";
import { describe, expect, it } from "vitest";
import { PrivacyRequestError } from "./errors.js";
import { assertValidRequestTransition, createSubjectRequestSchema } from "./request-contracts.js";

/** The owner-approved table, written out independently of the implementation. */
const ALLOWED = new Set([
  "open->in_progress",
  "open->waiting_on_requester",
  "open->refused",
  "in_progress->waiting_on_requester",
  "in_progress->completed",
  "in_progress->refused",
  "waiting_on_requester->in_progress",
  "waiting_on_requester->refused",
  "waiting_on_requester->completed",
]);

const pairs = REQUEST_STATES.flatMap((from) => REQUEST_STATES.map((to) => [from, to] as const));

describe("privacy request transition table", () => {
  it("has exactly the five request states", () => {
    expect(REQUEST_STATES).toEqual([
      "open",
      "in_progress",
      "waiting_on_requester",
      "completed",
      "refused",
    ]);
  });

  it.each(pairs.filter(([from, to]) => ALLOWED.has(`${from}->${to}`)))(
    "allows %s -> %s",
    (from, to) => {
      expect(isValidRequestTransition(from, to)).toBe(true);
      expect(() => assertValidRequestTransition(from, to)).not.toThrow();
    },
  );

  it.each(pairs.filter(([from, to]) => !ALLOWED.has(`${from}->${to}`)))(
    "refuses %s -> %s with INVALID_TRANSITION (409)",
    (from, to) => {
      expect(isValidRequestTransition(from, to)).toBe(false);
      let error: unknown;
      try {
        assertValidRequestTransition(from, to);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(PrivacyRequestError);
      expect(error).toMatchObject({ code: "INVALID_TRANSITION", statusCode: 409 });
    },
  );

  it("covers every one of the 25 ordered pairs", () => {
    expect(pairs).toHaveLength(25);
    expect(pairs.filter(([from, to]) => isValidRequestTransition(from, to))).toHaveLength(
      ALLOWED.size,
    );
  });
});

describe("named state predicates", () => {
  const states = (predicate: (state: RequestState) => boolean) =>
    REQUEST_STATES.filter((state) => predicate(state));

  it("splits the states into active and terminal sets", () => {
    expect(ACTIVE_REQUEST_STATES).toEqual(["open", "in_progress", "waiting_on_requester"]);
    expect(TERMINAL_REQUEST_STATES).toEqual(["completed", "refused"]);
    expect(states(isActiveRequestState)).toEqual([...ACTIVE_REQUEST_STATES]);
    expect(states(isTerminalRequestState)).toEqual([...TERMINAL_REQUEST_STATES]);
    for (const state of TERMINAL_REQUEST_STATES)
      expect(REQUEST_STATES.some((to) => isValidRequestTransition(state, to))).toBe(false);
  });

  it("allows case work only on active requests", () => {
    for (const predicate of [
      acceptsCaseDecision,
      canExtendDeadline,
      acceptsTaskResolution,
      acceptsSelfServiceExport,
    ])
      expect(states(predicate)).toEqual([...ACTIVE_REQUEST_STATES]);
  });

  it("allows a manual identity check before work starts", () => {
    expect(states(acceptsManualIdentityVerification)).toEqual(["open", "waiting_on_requester"]);
  });

  it("allows withdrawal exactly where the table reaches completed", () => {
    expect(states(acceptsWithdrawal)).toEqual(["in_progress", "waiting_on_requester"]);
  });
});

describe("subject request intake", () => {
  it("requires the account for self-service and a locator for assisted requests", () => {
    expect(createSubjectRequestSchema.safeParse({ channel: "self_service" }).success).toBe(false);
    expect(createSubjectRequestSchema.safeParse({ channel: "email" }).success).toBe(false);
    expect(
      createSubjectRequestSchema.safeParse({
        channel: "representative",
        subject: { locatorType: "email", locator: "a@example.test", accountState: "unknown" },
      }).success,
    ).toBe(true);
  });

  it("no longer accepts a representative contact", () => {
    expect(
      createSubjectRequestSchema.safeParse({
        channel: "representative",
        subject: { locatorType: "email", locator: "a@example.test", accountState: "unknown" },
        representative: { contactType: "email", contact: "b@example.test" },
      }).success,
    ).toBe(false);
  });
});
