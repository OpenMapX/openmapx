import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/test";
import {
  AccountAdminError,
  createAccountAdminClient,
  unwrapAuthResult,
  useAccountAction,
} from "./accountAdmin";

const state = vi.hoisted(() => ({
  apiUrl: "http://api-a.test",
  actorId: "actor-a",
  methods: Object.fromEntries(
    [
      "listUsers",
      "listUserSessions",
      "createUser",
      "updateUser",
      "setRole",
      "banUser",
      "unbanUser",
      "removeUser",
      "impersonateUser",
      "revokeUserSession",
      "revokeUserSessions",
      "reset",
      "privacy",
    ].map((key) => [key, vi.fn()]),
  ),
}));
vi.mock("@openmapx/core", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core")),
  authClient: {
    useSession: () => ({ data: { user: { id: state.actorId } } }),
    admin: state.methods,
    requestPasswordReset: state.methods.reset,
  },
  setPrivacyAdminRole: state.methods.privacy,
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: state.apiUrl }),
}));
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function wrapper({ children }: { children: React.ReactNode }) {
  const cache = createTestQueryClient();
  caches.push(cache);
  return createElement(QueryClientProvider, { client: cache }, children);
}
beforeEach(() => {
  vi.clearAllMocks();
  state.apiUrl = "http://api-a.test";
  state.actorId = "actor-a";
  for (const fn of Object.values(state.methods))
    fn.mockResolvedValue({
      data: null,
      error: { code: "FORBIDDEN", message: "secret diagnostic /private/provider" },
    });
});
afterEach(() => {
  for (const cache of caches.splice(0)) cache.clear();
});
it.each<[string, (c: ReturnType<typeof createAccountAdminClient>) => Promise<unknown>]>([
  ["list", (c: ReturnType<typeof createAccountAdminClient>) => c.list({ limit: 1 })],
  ["get", (c: ReturnType<typeof createAccountAdminClient>) => c.get("a")],
  ["count", (c: ReturnType<typeof createAccountAdminClient>) => c.count()],
  ["sessions", (c: ReturnType<typeof createAccountAdminClient>) => c.sessions("a")],
  [
    "create",
    (c: ReturnType<typeof createAccountAdminClient>) =>
      c.create({
        name: "Synthetic",
        email: "a@example.test",
        password: "synthetic-password",
        role: "user",
      }),
  ],
  ["name", (c: ReturnType<typeof createAccountAdminClient>) => c.updateName("a", "Synthetic")],
  ["role", (c: ReturnType<typeof createAccountAdminClient>) => c.changeRole("a", "admin", "user")],
  ["ban", (c: ReturnType<typeof createAccountAdminClient>) => c.ban("a")],
  ["unban", (c: ReturnType<typeof createAccountAdminClient>) => c.unban("a")],
  ["delete", (c: ReturnType<typeof createAccountAdminClient>) => c.remove("a")],
  ["impersonate", (c: ReturnType<typeof createAccountAdminClient>) => c.impersonate("a")],
  [
    "reset",
    (c: ReturnType<typeof createAccountAdminClient>) =>
      c.resetPassword("a@example.test", "http://ui.test"),
  ],
  ["revoke", (c: ReturnType<typeof createAccountAdminClient>) => c.revoke("synthetic-token")],
  ["revoke all", (c: ReturnType<typeof createAccountAdminClient>) => c.revokeAll("a")],
])("rejects a resolved Better Auth error for %s", async (_name, run) => {
  await expect(run(createAccountAdminClient(state.apiUrl))).rejects.toBeInstanceOf(
    AccountAdminError,
  );
});
it("does not include raw provider errors and rejects missing data", () => {
  expect(() => unwrapAuthResult({ data: null, error: null })).toThrow("The account request failed");
  expect(() => unwrapAuthResult({ data: null, error: { message: "secret" } })).not.toThrow(
    "secret",
  );
  expect(unwrapAuthResult({ data: false, error: null })).toBe(false);
});
it("captures origin and canonical role expectation for every write", async () => {
  const client = createAccountAdminClient(state.apiUrl);
  state.apiUrl = "http://api-b.test";
  await expect(client.changeRole("a", "admin", "user")).rejects.toThrow();
  expect(state.methods.setRole).toHaveBeenCalledWith(
    expect.objectContaining({
      role: "admin",
      fetchOptions: expect.objectContaining({
        baseURL: "http://api-a.test/api/auth",
        headers: expect.objectContaining({ "x-openmapx-expected-role": "user" }),
      }),
    }),
  );
  expect(state.methods.updateUser).not.toHaveBeenCalled();
});
it.each(["target", "actor", "origin", "unmount"])(
  "ignores an old completion after %s changes",
  async (change) => {
    let resolve!: (value: unknown) => void;
    const done = vi.fn(),
      error = vi.fn();
    const hook = renderHook(({ id }) => useAccountAction(id, { onSuccess: done, onError: error }), {
      initialProps: { id: "a" },
      wrapper,
    });
    await act(async () =>
      hook.result.current.mutate(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      ),
    );
    if (change === "actor") state.actorId = "actor-b";
    if (change === "origin") state.apiUrl = "http://api-b.test";
    if (change === "unmount") hook.unmount();
    else hook.rerender({ id: change === "target" ? "b" : "a" });
    await act(async () => resolve({ ok: true }));
    expect(done).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  },
);
it("allows only the expected impersonated actor in the same view", async () => {
  let resolve!: (value: unknown) => void;
  const done = vi.fn();
  const hook = renderHook(
    () => useAccountAction("subject-a", { impersonation: true, onSuccess: done }),
    { wrapper },
  );
  await act(async () =>
    hook.result.current.mutate(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  );
  state.actorId = "subject-a";
  hook.rerender();
  await act(async () => resolve({ user: { id: "subject-a" } }));
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
});
it("rejects an unrelated actor during impersonation", async () => {
  let resolve!: (value: unknown) => void;
  const done = vi.fn();
  const hook = renderHook(
    () => useAccountAction("subject-a", { impersonation: true, onSuccess: done }),
    { wrapper },
  );
  await act(async () =>
    hook.result.current.mutate(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  );
  state.actorId = "actor-c";
  hook.rerender();
  await act(async () => resolve({ user: { id: "subject-a" } }));
  expect(done).not.toHaveBeenCalled();
});
