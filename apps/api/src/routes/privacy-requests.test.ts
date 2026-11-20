import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateSubjectRequestDueAt } from "../privacy/deadline.js";
import { PrivacyRequestError } from "../privacy/errors.js";
import type { PrivacyRequestService } from "../privacy/request-service.js";

const auth = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../db/index.js", () => ({ db: {}, sql: {} }));
vi.mock("../auth.js", () => ({ auth: { api: { getSession: async () => auth.current } } }));
vi.mock("../privacy/session-assurance.js", () => ({ hasFreshAssurance: async () => true }));

const { privacyRequestsRoute } = await import("./privacy-requests.js");

const USER_ID = "user-1";
const VALID_ID = "11111111-1111-4111-8111-111111111111";
const IDEMPOTENCY_KEY = "withdraw-key-00000001";
/** What PostgreSQL does with a non-UUID string compared against a uuid column. */
const uuidCastFailure = () =>
  Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: "22P02" });

function signIn() {
  auth.current = {
    user: { id: USER_ID, role: "user", twoFactorEnabled: false },
    session: { id: "session-1", userId: USER_ID },
  };
}

async function appWith(service: Partial<PrivacyRequestService>) {
  const app = Fastify();
  await app.register(privacyRequestsRoute, {
    prefix: "/api",
    service: service as PrivacyRequestService,
  });
  return app;
}

afterEach(() => {
  auth.current = null;
});

describe("privacy request ids", () => {
  const malformed = ["-".repeat(36), "gggggggg-gggg-4ggg-8ggg-gggggggggggg", "1".repeat(36)];

  it.each(malformed)("answers detail for %j with 404 before querying", async (id) => {
    signIn();
    const getForUser = vi.fn(async () => {
      throw uuidCastFailure();
    });
    const app = await appWith({ getForUser });
    const response = await app.inject({ method: "GET", url: `/api/privacy/data-requests/${id}` });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found", code: "REQUEST_NOT_FOUND" });
    expect(getForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(malformed)("answers withdraw for %j with 404 before querying", async (id) => {
    signIn();
    const withdraw = vi.fn(async () => {
      throw uuidCastFailure();
    });
    const app = await appWith({ withdraw });
    const response = await app.inject({
      method: "POST",
      url: `/api/privacy/data-requests/${id}/withdraw`,
      headers: { "idempotency-key": IDEMPOTENCY_KEY },
      payload: { version: 1 },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not Found", code: "REQUEST_NOT_FOUND" });
    expect(withdraw).not.toHaveBeenCalled();
    await app.close();
  });

  it("still looks up a well-formed id", async () => {
    signIn();
    const getForUser = vi.fn(async () => {
      throw new PrivacyRequestError("REQUEST_NOT_FOUND", 404);
    });
    const app = await appWith({ getForUser });
    const response = await app.inject({
      method: "GET",
      url: `/api/privacy/data-requests/${VALID_ID}`,
    });
    expect(response.statusCode).toBe(404);
    expect(getForUser).toHaveBeenCalledWith(VALID_ID, USER_ID);
    await app.close();
  });
});

describe("self-service export time zone", () => {
  it("answers an unknown time zone with 400 before creating a request", async () => {
    signIn();
    // Stand-in for the real service: it computes the deadline the same way
    // `PrivacyRequestService.create` does, so an unvalidated zone throws here.
    const beginSelfServiceExport = vi.fn(async (input: { timeZone: string }) => {
      calculateSubjectRequestDueAt(new Date(), input.timeZone);
      throw new Error("the test only covers validation");
    });
    const app = await appWith({
      beginSelfServiceExport: beginSelfServiceExport as never,
      recordExportFailure: vi.fn(async () => undefined) as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/privacy/export",
      payload: { kind: "access_and_portability", locale: "en", timeZone: "Not/AZone" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Bad Request", code: "INVALID_REQUEST" });
    expect(beginSelfServiceExport).not.toHaveBeenCalled();
    await app.close();
  });
});
