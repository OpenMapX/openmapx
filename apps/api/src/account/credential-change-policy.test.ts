import { de, en } from "@openmapx/i18n";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import {
  type CredentialChangeDeps,
  type CredentialChangeSession,
  type EmailChangeNoticeCtx,
  enforceCredentialChangePolicy,
  FRESH_SIGN_IN_PATHS,
  IMPERSONATION_REFUSED_PATHS,
  notifyPreviousAddressOfEmailChange,
  refuseSecondProviderIdentity,
} from "./credential-change-policy";

function signedIn(overrides: {
  impersonatedBy?: string | null;
  twoFactorEnabled?: boolean | null;
}): CredentialChangeSession {
  return {
    session: { id: "session-1", userId: "user-1", impersonatedBy: overrides.impersonatedBy },
    user: { id: "user-1", twoFactorEnabled: overrides.twoFactorEnabled },
  };
}

function deps(options: {
  session?: CredentialChangeSession | null;
  fresh?: boolean;
  linked?: string[];
}) {
  return {
    loadSession: vi.fn(async () =>
      options.session === undefined ? signedIn({}) : options.session,
    ),
    isFresh: vi.fn(async () => options.fresh ?? false),
    linkedProviderIds: vi.fn(async () => options.linked ?? []),
  } satisfies CredentialChangeDeps;
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(APIError);
  const apiError = error as APIError;
  return { status: apiError.statusCode, code: (apiError.body as { code?: string }).code };
}

const PASSWORD_PROTECTED_PATHS = [
  "/change-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
];

describe("enforceCredentialChangePolicy", () => {
  it.each([...FRESH_SIGN_IN_PATHS])("refuses %s from a stale session", async (path) => {
    const fake = deps({ fresh: false });
    await expect(refusal(enforceCredentialChangePolicy({ path, body: {} }, fake))).resolves.toEqual(
      { status: 401, code: "FRESH_SIGN_IN_REQUIRED" },
    );
  });

  it.each([...FRESH_SIGN_IN_PATHS])("allows %s after a recent sufficient sign-in", async (path) => {
    const fake = deps({ session: signedIn({ twoFactorEnabled: true }), fresh: true });
    await expect(enforceCredentialChangePolicy({ path, body: {} }, fake)).resolves.toBeUndefined();
    expect(fake.isFresh).toHaveBeenCalledWith({
      sessionId: "session-1",
      userId: "user-1",
      mfaConfigured: true,
    });
  });

  it.each([...IMPERSONATION_REFUSED_PATHS])(
    "refuses %s from an impersonation session even when it is fresh",
    async (path) => {
      const fake = deps({
        session: signedIn({ impersonatedBy: "admin-1" }),
        fresh: true,
        linked: ["openstreetmap"],
      });
      await expect(
        refusal(enforceCredentialChangePolicy({ path, body: { provider: "openstreetmap" } }, fake)),
      ).resolves.toEqual({ status: 403, code: "IMPERSONATION_NOT_ALLOWED" });
      expect(fake.isFresh).not.toHaveBeenCalled();
    },
  );

  it.each(PASSWORD_PROTECTED_PATHS)(
    "leaves %s to its password check for a stale session",
    async (path) => {
      const fake = deps({ fresh: false });
      await expect(
        enforceCredentialChangePolicy({ path, body: {} }, fake),
      ).resolves.toBeUndefined();
      expect(fake.isFresh).not.toHaveBeenCalled();
    },
  );

  it("refuses linking a provider the account does not have yet from a stale session", async () => {
    const fake = deps({ fresh: false, linked: ["credential"] });
    await expect(
      refusal(
        enforceCredentialChangePolicy(
          { path: "/link-social", body: { provider: "openstreetmap" } },
          fake,
        ),
      ),
    ).resolves.toEqual({ status: 401, code: "FRESH_SIGN_IN_REQUIRED" });
    expect(fake.linkedProviderIds).toHaveBeenCalledWith("user-1");
  });

  it("allows more scopes for an already linked provider without a new sign-in", async () => {
    const fake = deps({ fresh: false, linked: ["credential", "openstreetmap"] });
    await expect(
      enforceCredentialChangePolicy(
        { path: "/link-social", body: { provider: "openstreetmap" } },
        fake,
      ),
    ).resolves.toBeUndefined();
    expect(fake.isFresh).not.toHaveBeenCalled();
  });

  it.each([{}, { provider: 42 }, null])(
    "treats a link request without a provider name (%j) as a new provider",
    async (body) => {
      const fake = deps({ fresh: false, linked: ["openstreetmap"] });
      await expect(
        refusal(enforceCredentialChangePolicy({ path: "/link-social", body }, fake)),
      ).resolves.toEqual({ status: 401, code: "FRESH_SIGN_IN_REQUIRED" });
    },
  );

  it.each(["/update-user", "/get-session"])("does not read the session on %s", async (path) => {
    const fake = deps({ fresh: false });
    await expect(enforceCredentialChangePolicy({ path, body: {} }, fake)).resolves.toBeUndefined();
    expect(fake.loadSession).not.toHaveBeenCalled();
  });

  it("leaves a request without a session to the endpoint's own 401", async () => {
    const fake = deps({ session: null });
    await expect(
      enforceCredentialChangePolicy({ path: "/delete-user", body: {} }, fake),
    ).resolves.toBeUndefined();
    expect(fake.isFresh).not.toHaveBeenCalled();
  });

  it("lets a passkey-only or federated account delete itself after a fresh sign-in", async () => {
    const fake = deps({ session: signedIn({ twoFactorEnabled: false }), fresh: true });
    await expect(
      enforceCredentialChangePolicy({ path: "/delete-user", body: {} }, fake),
    ).resolves.toBeUndefined();
    expect(fake.isFresh).toHaveBeenCalledWith(expect.objectContaining({ mfaConfigured: false }));
  });
});

describe("refuseSecondProviderIdentity", () => {
  function database(rows: { accountId: string }[]) {
    const where = vi.fn(async () => rows);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    return { select } as unknown as Parameters<typeof refuseSecondProviderIdentity>[1];
  }
  const data = { userId: "user-1", providerId: "openstreetmap", accountId: "4242" };

  it("allows the first identity of a provider", async () => {
    await expect(refuseSecondProviderIdentity(data, database([]))).resolves.toBeUndefined();
  });

  it("allows the same identity again", async () => {
    await expect(
      refuseSecondProviderIdentity(data, database([{ accountId: "4242" }])),
    ).resolves.toBeUndefined();
  });

  it("allows a different provider", async () => {
    // The query is scoped to the provider, so another provider's rows never match.
    await expect(
      refuseSecondProviderIdentity({ ...data, providerId: "mapillary" }, database([])),
    ).resolves.toBeUndefined();
  });

  it("refuses a second identity of an already linked provider", async () => {
    await expect(
      refuseSecondProviderIdentity(data, database([{ accountId: "9999" }])),
    ).resolves.toBe(false);
  });
});

describe("notifyPreviousAddressOfEmailChange", () => {
  function ctx(overrides: Partial<EmailChangeNoticeCtx> = {}): EmailChangeNoticeCtx {
    return {
      path: "/email-otp/change-email",
      body: { newEmail: "new@example.test", otp: "123456" },
      headers: new Headers(),
      context: {
        returned: { success: true },
        session: { user: { id: "user-1", email: "old@example.test" } },
        logger: { error: vi.fn() },
      },
      ...overrides,
    };
  }

  it("tells the previous address after a successful change", async () => {
    const send = vi.fn(async () => undefined);
    await notifyPreviousAddressOfEmailChange(ctx(), send);
    expect(send).toHaveBeenCalledTimes(1);
    const [message] = send.mock.calls[0] as unknown as [
      { to: string; subject: string; text: string; html: string; disclosure: unknown },
    ];
    expect(message.to).toBe("old@example.test");
    expect(message.subject).toContain(en.account.emailChangeNotice.subject);
    expect(message.disclosure).toEqual({
      userId: "user-1",
      operationCode: "auth.email-change.notice",
    });
    expect(message.text).not.toContain("new@example.test");
    expect(message.html).not.toContain("new@example.test");
  });

  it("writes in the language of the request", async () => {
    const send = vi.fn(async () => undefined);
    await notifyPreviousAddressOfEmailChange(
      ctx({ headers: new Headers({ cookie: "theme=dark; NEXT_LOCALE=de" }) }),
      send,
    );
    const [message] = send.mock.calls[0] as unknown as [{ subject: string; text: string }];
    expect(message.subject).toContain(de.account.emailChangeNotice.subject);
    expect(message.text).toContain(de.account.emailChangeNotice.unexpected);
  });

  it("skips a failed change", async () => {
    const send = vi.fn(async () => undefined);
    const base = ctx();
    await notifyPreviousAddressOfEmailChange(
      { ...base, context: { ...base.context, returned: new APIError("BAD_REQUEST") } },
      send,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("skips other routes", async () => {
    const send = vi.fn(async () => undefined);
    await notifyPreviousAddressOfEmailChange(
      ctx({ path: "/email-otp/request-email-change" }),
      send,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("skips a provider placeholder address", async () => {
    const send = vi.fn(async () => undefined);
    const base = ctx();
    await notifyPreviousAddressOfEmailChange(
      {
        ...base,
        context: {
          ...base.context,
          session: { user: { id: "user-1", email: "4242@osm.invalid" } },
        },
      },
      send,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("skips an unchanged address", async () => {
    const send = vi.fn(async () => undefined);
    await notifyPreviousAddressOfEmailChange(
      ctx({ body: { newEmail: "OLD@example.test", otp: "123456" } }),
      send,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("logs a delivery failure without failing the change", async () => {
    const send = vi.fn(async () => {
      throw new Error("mail down");
    });
    const notice = ctx();
    await expect(notifyPreviousAddressOfEmailChange(notice, send)).resolves.toBeUndefined();
    expect(notice.context.logger?.error).toHaveBeenCalledTimes(1);
  });
});
