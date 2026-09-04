import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => {
  const translators = new Map<string, ((key: string) => string) & { has: () => boolean }>();
  return {
    useTranslations: (namespace: string) => {
      let translator = translators.get(namespace);
      if (!translator) {
        translator = Object.assign((key: string) => `${namespace}.${key}`, { has: () => true });
        translators.set(namespace, translator);
      }
      return translator;
    },
    useFormatter: () => ({ dateTime: (value: Date) => value.toISOString() }),
  };
});

const PrivacyAdminPage = (await import("./page")).default;

const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function detail(id: string, registrationId: string) {
  return {
    request: {
      id,
      state: "identity_pending",
      kind: "access_and_portability",
      dueAt: "2026-10-01T00:00:00.000Z",
      version: id === CASE_A ? 3 : 7,
      identityState: "pending",
    },
    tasks: [
      {
        id: `${id}-task`,
        taskKey: "collect",
        registrationId,
        status: "complete",
        required: 1,
        assignedTo: null,
        recordCount: 1,
        exceptionCode: null,
        redactionCode: null,
      },
    ],
    artifacts: [],
    identities: [
      {
        party: "subject",
        state: "pending",
        method: null,
        authorityState: "not_required",
        deliveryAuthorized: 0,
        verifiedAt: null,
      },
    ],
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installFetch() {
  let deferCaseB = false;
  const staleCaseB = deferred<Response>();
  let caseBDeferred = false;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/privacy/admin/queue"))
      return Promise.resolve(
        json({
          requests: [
            detail(CASE_A, "registration-for-case-a").request,
            detail(CASE_B, "registration-for-case-b").request,
          ],
        }),
      );
    if (url.endsWith("/privacy/admin/readiness"))
      return Promise.resolve(
        json({
          ready: false,
          checkedAt: "2026-09-05T00:00:00.000Z",
          evidenceVersion: "v1",
          checks: [],
        }),
      );
    if (url.endsWith("/privacy/admin/backups")) return Promise.resolve(json({ backups: [] }));
    if (url.endsWith("/backup-omissions")) return Promise.resolve(json({ reviews: [] }));
    if (url.endsWith(`/privacy/admin/requests/${CASE_A}`))
      return Promise.resolve(json(detail(CASE_A, "registration-for-case-a")));
    if (url.endsWith(`/privacy/admin/requests/${CASE_B}`)) {
      if (deferCaseB && !caseBDeferred) {
        caseBDeferred = true;
        return staleCaseB.promise;
      }
      return Promise.resolve(json(detail(CASE_B, "registration-for-case-b")));
    }
    if (url.endsWith(`/privacy/admin/requests/${CASE_A}/identity/email-challenges`))
      return Promise.resolve(json({ challengeId: "challenge-for-case-a" }));
    throw new Error(`Unexpected request: ${url}`);
  });
  return {
    calls,
    beginDeferredCaseB: () => {
      deferCaseB = true;
    },
    staleCaseB,
    wasCaseBDeferred: () => caseBDeferred,
  };
}

describe("privacy admin case selection", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: () => "00000000-0000-4000-8000-000000000000",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the latest selected case when an older case response arrives last", async () => {
    const fixture = installFetch();
    render(<PrivacyAdminPage />);
    await screen.findByText("registration-for-case-a");

    fixture.beginDeferredCaseB();
    const caseButtons = screen.getAllByRole("button", {
      name: /^account\.privacyData\.accessAndPortability /,
    });
    fireEvent.click(caseButtons[1]);
    await waitFor(() => expect(fixture.wasCaseBDeferred()).toBe(true));
    fireEvent.click(caseButtons[0]);
    await screen.findByText("registration-for-case-a");

    await act(async () => {
      fixture.staleCaseB.resolve(json(detail(CASE_B, "registration-for-case-b")));
      await fixture.staleCaseB.promise;
    });

    await waitFor(() =>
      expect(screen.queryByText("registration-for-case-b")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("registration-for-case-a")).toBeInTheDocument();
  });

  it("drops an issued challenge and typed code when the selected case changes", async () => {
    installFetch();
    render(<PrivacyAdminPage />);
    await screen.findByText("registration-for-case-a");

    fireEvent.click(screen.getByRole("button", { name: "privacyAdmin.sendIdentityChallenge" }));
    const code = await screen.findByLabelText("privacyAdmin.identityCode");
    fireEvent.change(code, { target: { value: "123456" } });
    expect(
      (
        screen.getByRole("button", {
          name: "privacyAdmin.verifyIdentityCode",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    const caseButtons = screen.getAllByRole("button", {
      name: /^account\.privacyData\.accessAndPortability /,
    });
    fireEvent.click(caseButtons[1]);
    await screen.findByText("registration-for-case-b");

    expect(screen.queryByLabelText("privacyAdmin.identityCode")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "privacyAdmin.sendIdentityChallenge" }),
    ).toBeInTheDocument();
  });
});
