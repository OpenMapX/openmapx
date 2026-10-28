import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  adminReauthStorageKey,
  completeStoredAdminReauthentication,
} from "@/lib/admin/adminReauthentication";
import { cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { AdminReauthenticationDialog } from "./AdminReauthenticationDialog";

const mocks = vi.hoisted(() => ({ start: vi.fn(), complete: vi.fn() }));
vi.mock("@openmapx/core/api-admin-sdk", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core/api-admin-sdk")>(
    "@openmapx/core/api-admin-sdk",
  )),
  startAdminReauthentication: mocks.start,
  completeAdminReauthentication: mocks.complete,
}));
vi.mock("@openmapx/core", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core")),
  authClient: { useSession: () => ({ data: { user: { id: "actor-a" } } }) },
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
const first = "11111111-1111-4111-8111-111111111111",
  second = "22222222-2222-4222-8222-222222222222";
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.complete.mockResolvedValue({
    data: { completed: true },
    status: 200,
    headers: new Headers(),
  });
  mocks.start.mockImplementation(async (body: unknown) => ({
    data: {
      challengeId: (body as { purpose: string }).purpose === "credentials.import" ? first : second,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      loginPath: "/auth/admin",
    },
    status: 200,
    headers: new Headers(),
  }));
});
afterEach(cleanup);
function mount(child: React.ReactNode) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>{child}</QueryClientProvider>,
  );
}
it("starts the finite pair before login and stores no credentials", async () => {
  mount(
    <AdminReauthenticationDialog
      purposes={[
        {
          targetId: "candidate-a",
          purpose: "credentials.import",
          intentFingerprint: "a".repeat(64),
        },
        {
          purpose: "transit.credentials",
          targetId: "catalog-a",
          intentFingerprint: "b".repeat(64),
        },
      ]}
      onCompleted={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Prepare sign-in" }));
  await screen.findByRole("link", { name: "Sign in again" });
  expect(mocks.start).toHaveBeenCalledTimes(2);
  const stored = sessionStorage.getItem(adminReauthStorageKey("http://api.test")) ?? "";
  expect(stored).toContain(first);
  expect(stored).toContain(second);
  expect(stored).not.toMatch(/password|nonce|token|email/i);
});
it("does not report completed proof on a failed start", async () => {
  mocks.start.mockRejectedValue(Error("synthetic private diagnostic"));
  const done = vi.fn();
  mount(
    <AdminReauthenticationDialog
      purpose="account.verify"
      targetId="subject-a"
      onCompleted={done}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Prepare sign-in" }));
  await screen.findByRole("alert");
  expect(done).not.toHaveBeenCalled();
  expect(screen.queryByText("synthetic private diagnostic")).not.toBeInTheDocument();
  expect(sessionStorage.length).toBe(0);
});
it("completes exact stored references and restricts return to a fixed local surface", async () => {
  const key = adminReauthStorageKey("http://api.test");
  sessionStorage.setItem(
    key,
    JSON.stringify({
      phase: "login",
      requests: [{ purpose: "account.verify", targetId: "a" }],
      challengeIds: [first],
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      returnPath: "https://attacker.invalid",
    }),
  );
  await expect(completeStoredAdminReauthentication("http://api.test")).rejects.toThrow();
  expect(mocks.complete).not.toHaveBeenCalled();
});
it("resumes confirmation only for the matching completed intent", async () => {
  sessionStorage.setItem(
    adminReauthStorageKey("http://api.test"),
    JSON.stringify({
      phase: "completed",
      requests: [{ purpose: "account.verify", targetId: "subject-a" }],
      challengeIds: [first],
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      returnPath: "/admin/users",
    }),
  );
  const done = vi.fn();
  mount(
    <AdminReauthenticationDialog
      purpose="account.verify"
      targetId="subject-a"
      onCompleted={done}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue with verified sign-in" }));
  await waitFor(() => expect(done).toHaveBeenCalledWith([{ challengeId: first }]));
});

it("rejects expired stored ceremonies without attempting completion", async () => {
  sessionStorage.setItem(
    adminReauthStorageKey("http://api.test"),
    JSON.stringify({
      phase: "login",
      requests: [{ purpose: "account.verify", targetId: "subject-a" }],
      challengeIds: [first],
      expiresAt: new Date(Date.now() - 1).toISOString(),
      returnPath: "/admin/users",
    }),
  );
  await expect(completeStoredAdminReauthentication("http://api.test")).rejects.toThrow();
  expect(mocks.complete).not.toHaveBeenCalled();
});
it("does not expose a partial pair when its second start fails", async () => {
  let calls = 0;
  mocks.start.mockImplementation(async () => {
    if (calls++) throw Error("synthetic failure");
    return {
      status: 200,
      data: {
        challengeId: first,
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        loginPath: "/auth/admin",
      },
      headers: new Headers(),
    };
  });
  mount(
    <AdminReauthenticationDialog
      purposes={[
        {
          purpose: "credentials.import",
          targetId: "candidate-a",
          intentFingerprint: "a".repeat(64),
        },
        {
          purpose: "transit.credentials",
          targetId: "catalog-a",
          intentFingerprint: "b".repeat(64),
        },
      ]}
      onCompleted={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Prepare sign-in" }));
  await screen.findByRole("alert");
  expect(sessionStorage.length).toBe(0);
  expect(screen.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
});

it("rechecks resumed proof against the current session before handing it to an action", async () => {
  sessionStorage.setItem(
    adminReauthStorageKey("http://api.test"),
    JSON.stringify({
      phase: "completed",
      requests: [{ purpose: "account.verify", targetId: "subject-a" }],
      challengeIds: [first],
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      returnPath: "/admin/users",
    }),
  );
  mocks.complete.mockResolvedValue({
    status: 409,
    data: { error: "REAUTHENTICATION_FAILED" },
    headers: new Headers(),
  });
  const done = vi.fn();
  mount(
    <AdminReauthenticationDialog
      purpose="account.verify"
      targetId="subject-a"
      onCompleted={done}
      onClose={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue with verified sign-in" }));
  await waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
  expect(done).not.toHaveBeenCalled();
});
