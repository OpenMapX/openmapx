import {
  ACTIVE_REQUEST_STATUSES,
  acceptsCaseDecision,
  acceptsManualIdentityVerification,
  acceptsSelfServiceExport,
  acceptsTaskResolution,
  acceptsWithdrawal,
  canExtendDeadline,
  isActiveRequestStatus,
  isTerminalRequestStatus,
  isValidRequestTransition,
  REQUEST_STATUSES,
  type RequestStatus,
  TERMINAL_REQUEST_STATUSES,
} from "@openmapx/core/privacy";
import { describe, expect, it } from "vitest";
import { PrivacyRequestError } from "./errors.js";
import {
  assertValidRequestTransition,
  createSubjectRequestSchema,
  selfServiceExportSchema,
} from "./request-contracts.js";

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

const pairs = REQUEST_STATUSES.flatMap((from) => REQUEST_STATUSES.map((to) => [from, to] as const));

describe("privacy request transition table", () => {
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

describe("named status predicates", () => {
  const states = (predicate: (status: RequestStatus) => boolean) =>
    REQUEST_STATUSES.filter((status) => predicate(status));

  it("splits the statuses into active and terminal sets", () => {
    expect(states(isActiveRequestStatus)).toEqual([...ACTIVE_REQUEST_STATUSES]);
    expect(states(isTerminalRequestStatus)).toEqual([...TERMINAL_REQUEST_STATUSES]);
    for (const status of TERMINAL_REQUEST_STATUSES)
      expect(REQUEST_STATUSES.some((to) => isValidRequestTransition(status, to))).toBe(false);
  });

  it("allows case work only on active requests", () => {
    for (const predicate of [
      acceptsCaseDecision,
      canExtendDeadline,
      acceptsTaskResolution,
      acceptsSelfServiceExport,
    ])
      expect(states(predicate)).toEqual([...ACTIVE_REQUEST_STATUSES]);
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

  it("locates a subject only by kinds OpenMapX accounts have", () => {
    const parse = (locatorType: string) =>
      createSubjectRequestSchema.safeParse({
        channel: "email",
        subject: { locatorType, locator: "subject", accountState: "unknown" },
      }).success;
    expect(["user_id", "email", "erasure_reference", "other_reference"].map(parse)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(parse("username")).toBe(false);
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

describe("time zone intake", () => {
  it.each(["Not/AZone", "UTC; DROP TABLE x", "------"])("rejects %j", (timeZone) => {
    expect(selfServiceExportSchema.safeParse({ timeZone }).success).toBe(false);
    expect(
      createSubjectRequestSchema.safeParse({
        channel: "self_service",
        userId: "user-1",
        timeZone,
      }).success,
    ).toBe(false);
  });

  it.each(["UTC", "Europe/Berlin", "America/New_York"])("accepts %s", (timeZone) => {
    expect(selfServiceExportSchema.parse({ timeZone }).timeZone).toBe(timeZone);
  });

  it("defaults to UTC", () => {
    expect(selfServiceExportSchema.parse({}).timeZone).toBe("UTC");
  });
});
