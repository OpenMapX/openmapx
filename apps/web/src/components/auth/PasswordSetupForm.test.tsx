import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as rawRender,
  renderWithIntl as render,
  screen,
  waitFor,
} from "@/test";
import en from "../../../../../packages/i18n/locales/en.json";
import { PasswordSetupForm } from "./PasswordSetupForm";

const mocks = vi.hoisted(() => ({ reset: vi.fn() }));
vi.mock("@openmapx/core", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core")),
  authClient: { resetPassword: mocks.reset },
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  history.replaceState(null, "", "/auth/password#token=synthetic-reset-token-0001");
  mocks.reset.mockResolvedValue({ data: null, error: { code: "INVALID_TOKEN" } });
});
afterEach(cleanup);
it("does not report password success on a resolved auth error and retains input", async () => {
  await render(<PasswordSetupForm />, { messages: en });
  fireEvent.change(await screen.findByLabelText("New password"), {
    target: { value: "synthetic-new-password" },
  });
  fireEvent.change(screen.getByLabelText("Confirm password"), {
    target: { value: "synthetic-new-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole("alert")).toHaveTextContent(/expired|used/);
  expect(screen.getByLabelText("New password")).toHaveValue("synthetic-new-password");
  expect(screen.queryByText("Password saved.")).not.toBeInTheDocument();
  expect(location.search).toBe("");
  expect(location.hash).toBe("");
});
it("sends the bound token to the captured auth origin without claiming email verification", async () => {
  mocks.reset.mockResolvedValue({ data: { status: true }, error: null });
  await render(<PasswordSetupForm />, { messages: en });
  for (const label of ["New password", "Confirm password"])
    fireEvent.change(await screen.findByLabelText(label), {
      target: { value: "synthetic-new-password" },
    });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  await screen.findByText("Password saved.");
  expect(mocks.reset).toHaveBeenCalledWith(
    expect.objectContaining({
      token: "synthetic-reset-token-0001",
      newPassword: "synthetic-new-password",
      fetchOptions: expect.objectContaining({ baseURL: "http://api.test/api/auth" }),
    }),
  );
  expect(screen.getByText(/Email verification is separate/)).toBeVisible();
});

it("does not let an old request finish a newly opened token form", async () => {
  let resolve!: (value: unknown) => void;
  mocks.reset.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  await render(<PasswordSetupForm />, { messages: en });
  for (const label of ["New password", "Confirm password"])
    fireEvent.change(await screen.findByLabelText(label), {
      target: { value: "synthetic-password-a" },
    });
  fireEvent.click(screen.getByRole("button", { name: "Save password" }));
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  history.replaceState(null, "", "/auth/password#token=synthetic-reset-token-0002");
  await act(async () => window.dispatchEvent(new HashChangeEvent("hashchange")));
  expect(screen.getByLabelText("New password")).not.toBeDisabled();
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "synthetic-password-b" },
  });
  await act(async () => resolve({ data: { status: true }, error: null }));
  expect(screen.getByLabelText("New password")).toHaveValue("synthetic-password-b");
  expect(screen.queryByText("Password saved.")).not.toBeInTheDocument();
});

it("retains its scrubbed link across React Strict Mode effect replay", async () => {
  const { NextIntlClientProvider } = await import("next-intl");
  rawRender(
    <StrictMode>
      <NextIntlClientProvider locale="en" messages={en}>
        <PasswordSetupForm />
      </NextIntlClientProvider>
    </StrictMode>,
  );
  for (const label of ["New password", "Confirm password"])
    fireEvent.change(await screen.findByLabelText(label), {
      target: { value: "synthetic-strict-password" },
    });
  expect(screen.getByRole("button", { name: "Save password" })).not.toBeDisabled();
  expect(location.hash).toBe("");
});
