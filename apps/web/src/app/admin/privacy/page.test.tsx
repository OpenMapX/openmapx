vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);

import { createApiClient } from "@openmapx/core";
import { privacyDetail } from "@/components/admin/privacy/privacyFixtures.test-support";
import {
  PRIVACY_ADMIN_RESUME_KEY,
  savePendingPrivacyAdminDelivery,
} from "@/lib/admin/privacyReauthentication";
import { adminTestHistory } from "@/test/adminNavigation";
import { createQueryWrapper, createTestQueryClient } from "@/test/query";

const binding = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSession: () => ({ data: { user: { id: "synthetic-worker", role: "privacy_admin" } } }),
}));
vi.mock("@/components/admin/activity/activityQueries", () => ({
  useActivityClient: () => ({ client: binding.client, apiUrl: "http://privacy.test" }),
}));

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

const detail = privacyDetail;

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
    const url = input instanceof Request ? input.url : String(input);
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
    if (url.includes("/operators?"))
      return Promise.resolve(
        json({
          operators: [{ id: "synthetic-worker", name: "Synthetic worker" }],
          nextCursor: null,
        }),
      );
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
      return Promise.resolve(
        new Response(
          JSON.stringify({
            challengeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            expiresAt: "2030-01-01T00:10:00.000Z",
            deliveryState: "sent",
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
      );
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
    adminTestHistory.reset("/admin/privacy");
    sessionStorage.clear();
    binding.client = createApiClient({ baseUrl: "http://privacy.test", credentials: "include" });
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
    render(<PrivacyAdminPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });
    await screen.findByText(/registration-for-case-a/);

    fixture.beginDeferredCaseB();
    const caseButtons = screen.getAllByRole("button", {
      name: /^account\.privacyData\.accessAndPortability /,
    });
    fireEvent.click(caseButtons[1]);
    await waitFor(() => expect(fixture.wasCaseBDeferred()).toBe(true));
    fireEvent.click(caseButtons[0]);
    await screen.findByText(/registration-for-case-a/);

    await act(async () => {
      fixture.staleCaseB.resolve(json(detail(CASE_B, "registration-for-case-b")));
      await fixture.staleCaseB.promise;
    });

    await waitFor(() =>
      expect(screen.queryByText(/registration-for-case-b/)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/registration-for-case-a/)).toBeInTheDocument();
  });

  it("drops an issued challenge and typed code when the selected case changes", async () => {
    installFetch();
    render(<PrivacyAdminPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });
    await screen.findByText(/registration-for-case-a/);

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
    await screen.findByText(/registration-for-case-b/);

    expect(screen.queryByLabelText("privacyAdmin.identityCode")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "privacyAdmin.sendIdentityChallenge" }),
    ).toBeInTheDocument();
  });

  it("opens the case queue without a release readiness or backup inventory request", async () => {
    const fixture = installFetch();
    render(<PrivacyAdminPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });
    await screen.findByText(/registration-for-case-a/);

    expect(screen.queryByText("adminNavigation.privacyReadinessBlocked")).not.toBeInTheDocument();
    expect(fixture.calls.some(({ url }) => /\/readiness$|\/backups$|\/backup-/.test(url))).toBe(
      false,
    );
  });
});

function pendingDelivery(requestId = CASE_B) {
  savePendingPrivacyAdminDelivery({
    apiOrigin: "http://privacy.test",
    actorId: "synthetic-worker",
    requestId,
    artifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    challengeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    channel: "assisted",
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  });
}
it("restores a pending delivery on return without a case query", async () => {
  binding.client = createApiClient({ baseUrl: "http://privacy.test", credentials: "include" });
  sessionStorage.clear();
  adminTestHistory.reset("/admin/privacy");
  pendingDelivery();
  installFetch();
  render(<PrivacyAdminPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });
  await screen.findByText(/registration-for-case-b/);
  expect(sessionStorage.getItem(PRIVACY_ADMIN_RESUME_KEY)).not.toBeNull();
});
it("loads an explicitly addressed case independently and clears another case's pending delivery", async () => {
  binding.client = createApiClient({ baseUrl: "http://privacy.test", credentials: "include" });
  sessionStorage.clear();
  pendingDelivery();
  adminTestHistory.reset(`/admin/privacy?case=${CASE_A}`);
  installFetch();
  render(<PrivacyAdminPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });
  await screen.findByText(/registration-for-case-a/);
  expect(sessionStorage.getItem(PRIVACY_ADMIN_RESUME_KEY)).toBeNull();
});
it("clears pending delivery on a history-driven case switch", async () => {
  binding.client = createApiClient({ baseUrl: "http://privacy.test", credentials: "include" });
  sessionStorage.clear();
  adminTestHistory.reset(`/admin/privacy?case=${CASE_A}`);
  installFetch();
  render(<PrivacyAdminPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });
  await screen.findByText(/registration-for-case-a/);
  act(() => adminTestHistory.push(`/admin/privacy?case=${CASE_B}`));
  await screen.findByText(/registration-for-case-b/);
  pendingDelivery();
  act(() => adminTestHistory.back());
  await screen.findByText(/registration-for-case-a/);
  expect(sessionStorage.getItem(PRIVACY_ADMIN_RESUME_KEY)).toBeNull();
});

it("loads an addressed case that is outside the visible queue", async () => {
  binding.client = createApiClient({ baseUrl: "http://privacy.test", credentials: "include" });
  sessionStorage.clear();
  adminTestHistory.reset(`/admin/privacy?case=${CASE_A}`);
  installFetch();
  const fetchFixture = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).endsWith("/privacy/admin/queue")
      ? Promise.resolve(json({ requests: [detail(CASE_B).request] }))
      : fetchFixture(input, init),
  );
  render(<PrivacyAdminPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });
  await screen.findByText(/registration-for-case-a/);
  expect(screen.queryByText(/registration-for-case-b/)).not.toBeInTheDocument();
});
it.each([403, 404])(
  "does not substitute a queue case when an addressed case is refused (%s)",
  async (status) => {
    binding.client = createApiClient({ baseUrl: "http://privacy.test", credentials: "include" });
    sessionStorage.clear();
    adminTestHistory.reset(`/admin/privacy?case=${CASE_A}`);
    installFetch();
    const fetchFixture = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith(`/privacy/admin/requests/${CASE_A}`)
        ? Promise.resolve(Response.json({ error: "Unavailable" }, { status }))
        : fetchFixture(input, init),
    );
    render(<PrivacyAdminPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });
    await screen.findByText("privacyAdmin.caseFailed");
    expect(screen.queryByText(/registration-for-case-b/)).not.toBeInTheDocument();
  },
);
