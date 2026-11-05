import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, createTestQueryClient, fireEvent, render, screen, waitFor } from "@/test";
import { CreateUserDialog } from "./CreateUserDialog";

const mocks = vi.hoisted(() => ({
  provision: vi.fn(),
  delivery: vi.fn(),
  verify: vi.fn(),
  reset: vi.fn(),
  invite: vi.fn(),
  verification: vi.fn(),
  password: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@openmapx/core", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core")),
  authClient: {
    useSession: () => ({ data: { user: { id: "admin-a", role: "admin" } } }),
    admin: {
      createUser: vi.fn(async () => ({ data: { user: { id: "created-a" } }, error: null })),
    },
  },
}));
vi.mock("@openmapx/core/api-admin-sdk", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core/api-admin-sdk")>(
    "@openmapx/core/api-admin-sdk",
  )),
  createAdminAccount: mocks.provision,
  getAdminAccountDelivery: mocks.delivery,
  verifyAdminAccount: mocks.verify,
  sendAdminAccountPasswordReset: mocks.reset,
  inviteAdminAccount: mocks.invite,
  sendAdminAccountVerificationEmail: mocks.verification,
  setAdminAccountPassword: mocks.password,
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://admin.test" }),
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
  for (const fn of [mocks.verify, mocks.reset, mocks.invite, mocks.verification, mocks.password])
    fn.mockResolvedValue({
      status: 200,
      data: {
        userId: "subject-a",
        created: false,
        verificationDelivery: "not_requested",
        passwordSetupDelivery: "not_requested",
      },
    });
  mocks.provision.mockResolvedValue({
    status: 200,
    data: {
      userId: "created-a",
      created: true,
      verificationDelivery: "failed",
      passwordSetupDelivery: "unknown",
    },
  });
  mocks.delivery.mockResolvedValue({
    status: 200,
    data: {
      latest: {
        action: "create",
        requestedAt: new Date().toISOString(),
        verificationDelivery: "failed",
        passwordSetupDelivery: "unknown",
      },
    },
  });
});
afterEach(() => {
  cleanup();
  for (const cache of caches.splice(0)) cache.clear();
});
function fill() {
  fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Synthetic subject" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "synthetic@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic-password" } });
}
it("sends the invitation choice and keeps the existing account visible after a mail failure", async () => {
  const close = vi.fn();
  mount(<CreateUserDialog open onClose={close} />);
  fill();
  fireEvent.click(screen.getByRole("checkbox"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create" })));
  await waitFor(() => expect(mocks.provision).toHaveBeenCalledTimes(1));
  expect(mocks.provision.mock.calls[0]?.[0]).toMatchObject({ sendInvitation: false });
  expect(close).not.toHaveBeenCalled();
  expect(await screen.findByText(/Account created/)).toBeVisible();
  expect(screen.getByRole("link", { name: /View account/ })).toHaveAttribute(
    "href",
    "/admin/users/created-a",
  );
  expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
  expect(screen.getByText(/Outcome unknown/)).toBeVisible();
});
it("accepts no initial password and requests an actual setup invitation", async () => {
  mocks.provision.mockResolvedValue({
    status: 200,
    data: {
      userId: "created-a",
      created: true,
      verificationDelivery: "queued",
      passwordSetupDelivery: "queued",
    },
  });
  mount(<CreateUserDialog open onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Full Name"), { target: { value: "Synthetic subject" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "synthetic@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(mocks.provision).toHaveBeenCalledTimes(1));
  expect(mocks.provision.mock.calls[0]?.[0]).toMatchObject({ sendInvitation: true });
  expect(mocks.provision.mock.calls[0]?.[0]).not.toHaveProperty("password");
});
vi.mock("./AdminReauthenticationDialog", () => ({
  AdminReauthenticationDialog: (props: {
    purpose: string;
    targetId: string;
    onCompleted: (proofs: unknown[]) => void;
    onClose: () => void;
  }) => (
    <div>
      <span>{props.purpose}</span>
      <button
        type="button"
        onClick={() =>
          props.onCompleted([
            {
              purpose: props.purpose,
              targetId: props.targetId,
              challengeId: "11111111-1111-4111-8111-111111111111",
            },
          ])
        }
      >
        Complete fresh sign-in
      </button>
      <button type="button" onClick={props.onClose}>
        Cancel fresh sign-in
      </button>
    </div>
  ),
}));
it("requires confirmation and a purpose-bound sign-in before assisted verification", async () => {
  const { AccountRecoveryActions } = await import("./AccountRecoveryActions");
  mount(
    <AccountRecoveryActions
      user={{
        id: "subject-a",
        name: "Subject",
        email: "subject@example.test",
        emailVerified: false,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Verify email manually" }));
  expect(screen.getByRole("button", { name: "Confirm administrator sign-in" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "identity_verified_out_of_band" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm this action/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm administrator sign-in" }));
  expect(mocks.verify).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Complete fresh sign-in" }));
  await waitFor(() => expect(mocks.verify).toHaveBeenCalledTimes(1));
  expect(mocks.verify.mock.calls[0]).toEqual([
    "subject-a",
    {
      confirmed: true,
      reasonCode: "identity_verified_out_of_band",
      expectedEmail: "subject@example.test",
    },
    expect.objectContaining({
      "idempotency-key": expect.any(String),
      "x-openmapx-reauth-challenge": "11111111-1111-4111-8111-111111111111",
    }),
    expect.any(Object),
  ]);
});
it("canceling a reset sign-in leaves the target unchanged", async () => {
  const { AccountRecoveryActions } = await import("./AccountRecoveryActions");
  mount(
    <AccountRecoveryActions
      user={{
        id: "subject-a",
        name: "Subject",
        email: "subject@example.test",
        emailVerified: false,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Send password reset" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm this action/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm administrator sign-in" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel fresh sign-in" }));
  expect(mocks.reset).not.toHaveBeenCalled();
});

it.each([
  ["Send invitation", "account.invite", "invite"],
  ["Send verification email", "account.invite", "verification"],
  ["Send password reset", "account.reset.send", "reset"],
  ["Set temporary password", "account.password.set", "password"],
] as const)(
  "uses the exact confirmed and reauthenticated %s action",
  async (label, purpose, method) => {
    const { AccountRecoveryActions } = await import("./AccountRecoveryActions");
    mount(
      <AccountRecoveryActions
        user={{
          id: "subject-a",
          name: "Subject",
          email: "subject@example.test",
          emailVerified: false,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: label }));
    if (method === "password") {
      fireEvent.change(screen.getByLabelText("Temporary password"), {
        target: { value: "synthetic-temporary-password" },
      });
      fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "account_recovery" } });
    }
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm this action/ }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm administrator sign-in" }));
    expect(await screen.findByText(purpose)).toBeVisible();
    expect(mocks[method]).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Complete fresh sign-in" }));
    await waitFor(() => expect(mocks[method]).toHaveBeenCalledTimes(1));
    expect(mocks[method].mock.calls[0]?.[0]).toBe("subject-a");
    expect(mocks[method].mock.calls[0]?.[1]).toEqual(
      method === "password"
        ? {
            confirmed: true,
            reasonCode: "account_recovery",
            password: "synthetic-temporary-password",
          }
        : { confirmed: true },
    );
  },
);
it("does not clear a newly selected account's password when the old account finishes", async () => {
  const { AccountRecoveryActions } = await import("./AccountRecoveryActions");
  let resolve!: (value: unknown) => void;
  mocks.password.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = mount(
    <AccountRecoveryActions
      user={{ id: "subject-a", name: "Subject A", email: "a@example.test", emailVerified: false }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Set temporary password" }));
  fireEvent.change(screen.getByLabelText("Temporary password"), {
    target: { value: "synthetic-password-a" },
  });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "account_recovery" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /I confirm this action/ }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm administrator sign-in" }));
  fireEvent.click(await screen.findByRole("button", { name: "Complete fresh sign-in" }));
  await waitFor(() => expect(mocks.password).toHaveBeenCalledTimes(1));
  view.rerender(
    <QueryClientProvider client={view.cache}>
      <AccountRecoveryActions
        user={{ id: "subject-b", name: "Subject B", email: "b@example.test", emailVerified: false }}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Set temporary password" }));
  fireEvent.change(screen.getByLabelText("Temporary password"), {
    target: { value: "synthetic-password-b" },
  });
  await act(async () =>
    resolve({
      status: 200,
      data: {
        userId: "subject-a",
        created: false,
        verificationDelivery: "not_requested",
        passwordSetupDelivery: "not_requested",
      },
    }),
  );
  expect(screen.getByLabelText("Temporary password")).toHaveValue("synthetic-password-b");
  expect(
    screen.queryByText("Account action completed. Check mail status separately."),
  ).not.toBeInTheDocument();
});
it("retries a rejected create with the same key until its intent is edited", async () => {
  mocks.provision.mockResolvedValue({ status: 503, data: { error: "ACCOUNT_ACTION_UNAVAILABLE" } });
  mount(<CreateUserDialog open onClose={vi.fn()} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(mocks.provision).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(mocks.provision).toHaveBeenCalledTimes(2));
  expect(mocks.provision.mock.calls[0]?.[1]).toEqual(mocks.provision.mock.calls[1]?.[1]);
});
