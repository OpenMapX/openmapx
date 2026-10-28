import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { BanUserDialog } from "./BanUserDialog";
import { CreateUserDialog } from "./CreateUserDialog";
import { UserDetail } from "./UserDetail";
import { UserList } from "./UserList";

const mocks = vi.hoisted(() => ({
  sessions: vi.fn(),
  revoke: vi.fn(),
  revokeAll: vi.fn(),
  remove: vi.fn(),
  role: vi.fn(),
  update: vi.fn(),
  unban: vi.fn(),
  impersonate: vi.fn(),
  create: vi.fn(),
  ban: vi.fn(),
  list: vi.fn(),
  toast: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@openmapx/core", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core")),
  authClient: {
    useSession: () => ({ data: { user: { id: "admin-a", role: "admin" } } }),
    admin: {
      createUser: mocks.create,
      banUser: mocks.ban,
      listUsers: mocks.list,
      listUserSessions: mocks.sessions,
      revokeUserSession: mocks.revoke,
      revokeUserSessions: mocks.revokeAll,
      removeUser: mocks.remove,
      setRole: mocks.role,
      updateUser: mocks.update,
      unbanUser: mocks.unban,
      impersonateUser: mocks.impersonate,
    },
  },
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://admin-a.test" }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("../shared/AdminToast", () => ({ useAdminToast: () => mocks.toast }));
const caches: ReturnType<typeof createTestQueryClient>[] = [];
function mount(child: React.ReactNode) {
  const cache = createTestQueryClient();
  caches.push(cache);
  return Object.assign(render(<QueryClientProvider client={cache}>{child}</QueryClientProvider>), {
    cache,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    "sessions",
    "revoke",
    "revokeAll",
    "remove",
    "role",
    "update",
    "unban",
    "impersonate",
  ] as const)
    mocks[key].mockResolvedValue({
      data: null,
      error: { code: "FORBIDDEN", message: "synthetic private error" },
    });
  mocks.list.mockResolvedValue({
    data: null,
    error: { code: "SERVICE_UNAVAILABLE", message: "synthetic provider diagnostic" },
  });
  mocks.create.mockResolvedValue({
    data: null,
    error: { code: "INVALID_PASSWORD", message: "synthetic provider diagnostic" },
  });
  mocks.ban.mockResolvedValue({
    data: null,
    error: { code: "LAST_ADMIN_REQUIRED", message: "synthetic provider diagnostic" },
  });
});
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
});
it("keeps creation input and dialog open when Better Auth resolves an error", async () => {
  const close = vi.fn();
  mount(<CreateUserDialog open onClose={close} />);
  fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Synthetic user" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "synthetic@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic-password" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Password")).toHaveValue("synthetic-password");
  expect(mocks.toast.mock.calls[0]?.[1]).toBe("error");
});
it("does not close or celebrate a rejected ban", async () => {
  const close = vi.fn();
  mount(<BanUserDialog user={{ id: "subject-a", name: "Synthetic account" }} onClose={close} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ban User" })));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalled());
  expect(close).not.toHaveBeenCalled();
  expect(mocks.toast.mock.calls[0]?.[1]).toBe("error");
});

it("shows a read failure instead of a successful empty account list", async () => {
  mount(<UserList />);
  await screen.findByText(/Could not load accounts/);
  expect(screen.queryByText("No users found")).not.toBeInTheDocument();
});
it("shows a failed detail read instead of claiming the account is absent", async () => {
  mount(<UserDetail userId="subject-a" />);
  await screen.findByText(/Could not load this account/);
  expect(screen.queryByText("User not found.")).not.toBeInTheDocument();
});

const subject = {
  id: "subject-a",
  name: "Synthetic account",
  email: "subject@example.test",
  role: "user",
  emailVerified: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};
function goodList() {
  mocks.list.mockResolvedValue({ data: { users: [subject], total: 1 }, error: null });
}
it("retains confirmed rows when a later list read fails", async () => {
  goodList();
  const view = mount(<UserList />);
  await screen.findByText(subject.email);
  mocks.list.mockResolvedValue({ data: null, error: { code: "FORBIDDEN" } });
  await act(async () => {
    await view.cache.invalidateQueries();
  });
  expect(await screen.findByText(/Could not load accounts/)).toBeVisible();
  expect(screen.getByText(subject.email)).toBeVisible();
});
it("leaves the selected deletion open and row intact after a resolved deletion error", async () => {
  goodList();
  mount(<UserList />);
  await screen.findByText(subject.email);
  fireEvent.click(screen.getByLabelText("User actions"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), "error"));
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.getByText(subject.email)).toBeInTheDocument();
  expect(mocks.push).not.toHaveBeenCalled();
});
it.each(["Revoke", "Revoke All Sessions"])(
  "retains confirmed sessions after rejected %s",
  async (label) => {
    goodList();
    mocks.sessions.mockResolvedValue({
      data: {
        sessions: [
          {
            id: "session-a",
            token: "synthetic-token",
            ipAddress: "192.0.2.1",
            createdAt: subject.createdAt,
            expiresAt: "2030-01-01T00:00:00Z",
          },
        ],
      },
      error: null,
    });
    mount(<UserDetail userId={subject.id} />);
    await screen.findByText(subject.email);
    fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
    await screen.findByText("192.0.2.1");
    fireEvent.click(screen.getByRole("button", { name: label }));
    await screen.findByText("You do not have permission to perform this account action.");
    expect(screen.getByText("192.0.2.1")).toBeVisible();
  },
);
it("shows failed sessions as unavailable instead of empty", async () => {
  goodList();
  mount(<UserDetail userId={subject.id} />);
  await screen.findByText(subject.email);
  fireEvent.click(screen.getByRole("tab", { name: "Sessions" }));
  await screen.findByText("Could not load sessions.");
  expect(screen.queryByText("No active sessions")).not.toBeInTheDocument();
});
it.each(["list", "detail"])(
  "uses a scalar canonical expected-role mutation from %s",
  async (view) => {
    goodList();
    mount(view === "list" ? <UserList /> : <UserDetail userId={subject.id} />);
    await screen.findByText(subject.email);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Role" }));
    fireEvent.click(screen.getByRole("option", { name: "Admin" }));
    if (view === "detail") fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(mocks.role).toHaveBeenCalledTimes(1));
    expect(mocks.role).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: subject.id,
        role: "admin",
        fetchOptions: expect.objectContaining({
          headers: expect.objectContaining({ "x-openmapx-expected-role": "user" }),
        }),
      }),
    );
    expect(mocks.update).not.toHaveBeenCalled();
    if (view === "list")
      await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.any(String), "error"));
    else await screen.findByText("You do not have permission to perform this account action.");
  },
);
it("a closed and reopened create dialog keeps new inputs when the old request completes", async () => {
  let resolve!: (value: unknown) => void;
  mocks.create.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const close = vi.fn();
  const cache = createTestQueryClient();
  caches.push(cache);
  const child = (open: boolean) => (
    <QueryClientProvider client={cache}>
      <CreateUserDialog open={open} onClose={close} />
    </QueryClientProvider>
  );
  const view = render(child(true));
  for (const [label, value] of [
    ["Full Name", "First"],
    ["Email", "first@example.test"],
    ["Password", "synthetic-password"],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  view.rerender(child(false));
  view.rerender(child(true));
  fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Second" } });
  await act(async () => resolve({ data: { user: subject }, error: null }));
  expect(screen.getByLabelText("Full Name")).toHaveValue("Second");
  expect(close).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});
