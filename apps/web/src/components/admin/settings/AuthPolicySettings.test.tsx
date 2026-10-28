import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";

const mocks = vi.hoisted(() => ({ get: vi.fn(), apply: vi.fn() }));
vi.mock("@openmapx/core", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core")),
  authClient: {
    useSession: () => ({ data: { user: { id: "admin-a", role: "admin" } } }),
    admin: {},
  },
}));
vi.mock("@openmapx/core/api-admin-sdk", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core/api-admin-sdk")>(
    "@openmapx/core/api-admin-sdk",
  )),
  getAdminAuthPolicy: mocks.get,
  applyAdminAuthPolicy: mocks.apply,
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://admin.test" }),
}));
const active = {
  emailVerificationRequired: true,
  sessionDurationHours: 168,
  twoFaEnabled: true,
  passwordMinLength: 8,
  activationVersion: 0,
  revision: "a".repeat(64),
};
const view = {
  active,
  pending: {
    emailVerificationRequired: false,
    twoFaEnabled: false,
    sessionDurationHours: 24,
    passwordMinLength: 10,
  },
  ownership: {
    emailVerificationRequired: "default",
    sessionDurationHours: "default",
    twoFaEnabled: "default",
    passwordMinLength: "default",
  },
};
const caches: ReturnType<typeof createTestQueryClient>[] = [];
async function mount() {
  const { AuthPolicySettings } = await import("./AuthPolicySettings"),
    cache = createTestQueryClient();
  caches.push(cache);
  return render(
    <QueryClientProvider client={cache}>
      <AuthPolicySettings />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ status: 200, data: view });
  mocks.apply.mockResolvedValue({ status: 409, data: { error: "AUTH_POLICY_CONFLICT" } });
});
afterEach(() => {
  cleanup();
  for (const c of caches.splice(0)) c.clear();
});
it("keeps effective defaults separate from legacy false drafts and rejects invalid bounds", async () => {
  await mount();
  expect(await screen.findByText(/safe defaults are active/)).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "Require email verification" })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Allow new 2FA enrollment" })).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Load legacy draft" }));
  expect(screen.getByRole("checkbox", { name: "Require email verification" })).not.toBeChecked();
  expect(mocks.apply).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("New session lifetime (hours)"), {
    target: { value: "0" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed/ }));
  expect(screen.getByRole("button", { name: "Activate authentication policy" })).toBeDisabled();
});
it("applies all four values atomically with original revision and preserves drafts after rejection", async () => {
  await mount();
  await screen.findByText(/safe defaults are active/);
  fireEvent.change(screen.getByLabelText("New session lifetime (hours)"), {
    target: { value: "24" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed/ }));
  fireEvent.click(screen.getByRole("button", { name: "Activate authentication policy" }));
  await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(1));
  expect(mocks.apply.mock.calls[0]?.[0]).toMatchObject({
    settings: {
      emailVerificationRequired: true,
      sessionDurationHours: 24,
      twoFaEnabled: true,
      passwordMinLength: 8,
    },
    expectedRevision: active.revision,
    confirmed: true,
  });
  expect(await screen.findByText(/active policy changed/)).toBeVisible();
  expect(screen.getByLabelText("New session lifetime (hours)")).toHaveValue(24);
  expect(screen.getByText(/safe defaults are active/)).toBeVisible();
});

it("preserves the host-owned verification setting when loading a legacy draft", async () => {
  mocks.get.mockResolvedValue({
    status: 200,
    data: {
      ...view,
      active: { ...active, activationVersion: 1 },
      ownership: { ...view.ownership, emailVerificationRequired: "env" },
    },
  });
  await mount();
  const locked = await screen.findByRole("checkbox", { name: "Require email verification" });
  expect(locked).toBeChecked();
  expect(locked).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Load legacy draft" }));
  expect(locked).toBeChecked();
});
