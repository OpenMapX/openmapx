import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import z from "zod/v4";
import { AdminReauthenticationError } from "../account/admin-reauthentication.js";
import { PrivacyRequestError, privacyErrorReply, privacyErrorResponse } from "./errors.js";
import { PrivacyIdempotencyError } from "./idempotency.js";
import { assertValidRequestTransition } from "./request-contracts.js";

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("privacy error mapping", () => {
  it("maps validation failures to 400", () => {
    const zod = thrown(() => z.strictObject({ version: z.number() }).parse({ version: "1" }));
    expect(privacyErrorResponse(zod)).toEqual({ statusCode: 400, code: "INVALID_REQUEST" });
    expect(privacyErrorResponse(new PrivacyRequestError("INVALID_REASON", 400))).toEqual({
      statusCode: 400,
      code: "INVALID_REASON",
    });
  });

  it("maps an invalid transition and spent proofs to 409 with their codes", () => {
    expect(
      privacyErrorResponse(thrown(() => assertValidRequestTransition("completed", "open"))),
    ).toEqual({ statusCode: 409, code: "INVALID_TRANSITION" });
    expect(privacyErrorResponse(new PrivacyIdempotencyError())).toEqual({
      statusCode: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(privacyErrorResponse(new AdminReauthenticationError())).toEqual({
      statusCode: 409,
      code: "REAUTHENTICATION_FAILED",
    });
  });

  it("keeps the declared status of domain errors", () => {
    expect(privacyErrorResponse(new PrivacyRequestError("FRESH_SIGN_IN_REQUIRED", 401))).toEqual({
      statusCode: 401,
      code: "FRESH_SIGN_IN_REQUIRED",
    });
    expect(privacyErrorResponse(new PrivacyRequestError("REQUEST_NOT_FOUND", 404))).toEqual({
      statusCode: 404,
      code: "REQUEST_NOT_FOUND",
    });
    expect(
      privacyErrorResponse(new PrivacyRequestError("PRIVACY_CONFIGURATION_INCOMPLETE", 503)),
    ).toEqual({ statusCode: 503, code: "PRIVACY_CONFIGURATION_INCOMPLETE" });
  });

  it("answers anything unknown with 503 and no detail", () => {
    for (const error of [new Error("database is down: secret detail"), "boom", null])
      expect(privacyErrorResponse(error)).toEqual({
        statusCode: 503,
        code: "PRIVACY_SERVICE_UNAVAILABLE",
      });
  });

  it("writes only the code to the reply", async () => {
    const app = Fastify();
    app.get("/fail", (_request, reply) => privacyErrorReply(reply, new Error("secret detail")));
    try {
      const response = await app.inject({ method: "GET", url: "/fail" });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: "PRIVACY_SERVICE_UNAVAILABLE" });
    } finally {
      await app.close();
    }
  });
});
