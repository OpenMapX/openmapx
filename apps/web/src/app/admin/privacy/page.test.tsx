vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);

import { createApiClient } from "@openmapx/core";
import { privacyDetail } from "@/components/admin/privacy/privacyFixtures.test-support";
import { adminTestHistory } from "@/test/adminNavigation";
import { createQueryWrapper, createTestQueryClient } from "@/test/query";

const binding = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSession: () => ({ data: { user: { id: "synthetic-worker", role: "admin" } } }),
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
    if (url.endsWith(`/privacy/admin/requests/${CASE_A}`))
      return Promise.resolve(json(detail(CASE_A, "registration-for-case-a")));
    if (url.endsWith(`/privacy/admin/requests/${CASE_B}`)) {
      if (deferCaseB && !caseBDeferred) {
        caseBDeferred = true;
        return staleCaseB.promise;
      }
      return Promise.resolve(json(detail(CASE_B, "registration-for-case-b")));
    }
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

  it("drops a typed identity reason when the selected case changes", async () => {
    installFetch();
    render(<PrivacyAdminPage />, { wrapper: createQueryWrapper(createTestQueryClient()) });
    await screen.findByText(/registration-for-case-a/);

    const [reason] = screen.getAllByLabelText("privacyAdmin.workflows.reasonCode");
    fireEvent.change(reason as HTMLElement, { target: { value: "checked-by-letter" } });
    expect(
      (screen.getByRole("button", { name: "privacyAdmin.verifyIdentity" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    const caseButtons = screen.getAllByRole("button", {
      name: /^account\.privacyData\.accessAndPortability /,
    });
    fireEvent.click(caseButtons[1]);
    await screen.findByText(/registration-for-case-b/);

    const [fresh] = screen.getAllByLabelText("privacyAdmin.workflows.reasonCode");
    expect((fresh as HTMLInputElement).value).toBe("");
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
