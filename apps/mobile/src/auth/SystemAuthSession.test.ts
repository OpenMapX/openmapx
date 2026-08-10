import { type SystemAuthConfig, SystemAuthSession } from "./SystemAuthSession";

const CONFIG: SystemAuthConfig = { webOrigin: "https://openmapx.com", scheme: "openmapx" };

const VERIFIER = "v".repeat(43);
const STATE = "s".repeat(22);
const CODE = "c".repeat(43);

/** A deterministic stand-in for the platform CSPRNG. */
const randomBytes = (length: number) => (length === 32 ? VERIFIER : STATE);
/**
 * A stand-in digest that does not embed its input — otherwise the assertion
 * that the verifier never reaches the URL would pass or fail on the fake.
 */
const sha256 = async (input: string) => `d${input.length}${"h".repeat(42)}`;
const CHALLENGE = `d43${"h".repeat(42)}`;

function harness(callback: (url: string, redirect: string) => Promise<string | null>) {
  const opened: { url: string; redirect: string }[] = [];
  const session = new SystemAuthSession(
    {
      config: CONFIG,
      randomBytes,
      browser: {
        openAuthSessionAsync: async (url, redirect) => {
          opened.push({ url, redirect });
          return callback(url, redirect);
        },
      },
    },
    sha256,
  );
  return { session, opened };
}

const successCallback = (code = CODE, state = STATE) =>
  `openmapx://auth/callback?code=${code}&state=${state}`;

describe("SystemAuthSession.open", () => {
  it("builds the URL from the compiled origin", async () => {
    const { session, opened } = harness(async () => successCallback());

    await session.open("sign-in");

    // No caller and no bridge message can contribute a host, a path, or a
    // redirect.
    const url = new URL(opened[0].url);
    expect(url.origin).toBe("https://openmapx.com");
    expect(url.pathname).toBe("/mobile-auth");
    expect(opened[0].redirect).toBe("openmapx://auth/callback");
  });

  it("sends the challenge, state and purpose — and nothing else", async () => {
    const { session, opened } = harness(async () => successCallback());

    await session.open("add-passkey");

    const params = new URL(opened[0].url).searchParams;
    expect(params.get("purpose")).toBe("add-passkey");
    expect(params.get("state")).toBe(STATE);
    expect(params.get("code_challenge")).toBe(CHALLENGE);
    expect(params.get("code_challenge_method")).toBe("S256");
    // The verifier is the one thing that must never leave the device.
    expect(opened[0].url).not.toContain(VERIFIER);
  });

  it("returns the code, state and verifier on success", async () => {
    const { session } = harness(async () => successCallback());

    await expect(session.open("sign-in")).resolves.toEqual({
      status: "ok",
      callbackCode: CODE,
      state: STATE,
      codeVerifier: VERIFIER,
    });
  });

  it("reports a dismissed browser as cancelled", async () => {
    const { session } = harness(async () => null);

    await expect(session.open("sign-in")).resolves.toEqual({ status: "cancelled" });
  });

  it("keeps nothing in memory once it has answered", async () => {
    const { session } = harness(async () => successCallback());

    await session.open("sign-in");

    // A copy left behind is a copy that can outlive the attempt.
    expect(session.hasAttemptInFlight).toBe(false);
  });

  it("keeps nothing in memory after a failure", async () => {
    const { session } = harness(async () => {
      throw new Error("browser exploded");
    });

    await expect(session.open("sign-in")).resolves.toEqual({ status: "failed" });
    expect(session.hasAttemptInFlight).toBe(false);
  });

  it("refuses a second concurrent attempt", async () => {
    let release!: (value: string | null) => void;
    const { session } = harness(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );

    const first = session.open("sign-in");
    // The challenge is computed before the browser opens, so give that a turn.
    await Promise.resolve();
    // Two live verifiers would make the returned callback ambiguous.
    await expect(session.open("sign-in")).resolves.toEqual({ status: "failed" });
    release(successCallback());
    await first;
  });
});

describe("SystemAuthSession callback validation", () => {
  it.each([
    {
      label: "a different scheme",
      url: `openmapx-evil://auth/callback?code=${CODE}&state=${STATE}`,
    },
    {
      label: "an https callback",
      url: `https://openmapx.com/auth/callback?code=${CODE}&state=${STATE}`,
    },
    { label: "a different host", url: `openmapx://elsewhere/callback?code=${CODE}&state=${STATE}` },
    { label: "a different path", url: `openmapx://auth/other?code=${CODE}&state=${STATE}` },
    { label: "userinfo", url: `openmapx://user@auth/callback?code=${CODE}&state=${STATE}` },
    { label: "no code", url: `openmapx://auth/callback?state=${STATE}` },
    { label: "no state", url: `openmapx://auth/callback?code=${CODE}` },
    { label: "not a URL", url: "nonsense" },
  ])("refuses $label", async ({ url }) => {
    const { session } = harness(async () => url);

    await expect(session.open("sign-in")).resolves.toEqual({ status: "failed" });
  });

  it("refuses a callback for a different attempt", async () => {
    const { session } = harness(async () => successCallback(CODE, "different-state-value"));

    // It belongs to another attempt, or to no attempt of ours at all.
    await expect(session.open("sign-in")).resolves.toEqual({ status: "failed" });
  });

  it.each(["short", "x".repeat(300), "not+base64/url="])(
    "refuses a malformed code %j",
    async (code) => {
      const { session } = harness(async () => successCallback(code));

      await expect(session.open("sign-in")).resolves.toEqual({ status: "failed" });
    },
  );
});

describe("SystemAuthSession.cancel", () => {
  it("forgets an attempt outright", async () => {
    let release!: (value: string | null) => void;
    const { session } = harness(
      () =>
        new Promise<string | null>((resolve) => {
          release = resolve;
        }),
    );
    const pending = session.open("sign-in");
    await Promise.resolve();

    session.cancel();

    // Backgrounding, restarting, or the user walking away: the honest answer to
    // an interrupted sign-in is to sign in again.
    expect(session.hasAttemptInFlight).toBe(false);
    release(null);
    await pending;
  });
});
