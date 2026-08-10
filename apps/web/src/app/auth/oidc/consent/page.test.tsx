import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, userEvent, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
const useSearchParams = vi.fn();
vi.mock("next/navigation", () => ({
  useSearchParams,
}));

const publicClient = vi.fn();
const consent = vi.fn();

vi.mock("@openmapx/core", () => ({
  authClient: { oauth2: { publicClient, consent } },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useSearchParams.mockImplementation(() => new URLSearchParams(window.location.search));
  window.history.replaceState(
    {},
    "",
    "/auth/oidc/consent?client_id=managed-client&scope=openid%20profile%20email",
  );
  publicClient.mockResolvedValue({
    data: {
      client_id: "managed-client",
      client_name: "Dawarich Timeline",
      client_uri: "https://timeline.example.test/about",
    },
    error: null,
  });
  consent.mockResolvedValue({ data: { redirect: true }, error: null });
});

describe("OIDC consent page", () => {
  it("renders a loading fallback while Next resolves the search-parameter reader", async () => {
    useSearchParams.mockImplementation(() => {
      throw new Promise(() => undefined);
    });
    const { default: Page } = await import("./page");
    render(<Page />);

    expect(screen.getByLabelText("auth.oidcProvider.loadingClient")).not.toBeNull();
  });

  it("loads safe public client details and explains only standard requested scopes", async () => {
    const { default: Page } = await import("./page");
    render(<Page />);

    expect(await screen.findByText("Dawarich Timeline")).not.toBeNull();
    expect(screen.getByText("timeline.example.test")).not.toBeNull();
    expect(publicClient).toHaveBeenCalledWith({ query: { client_id: "managed-client" } });
    expect(screen.getByText("auth.oidcProvider.scopes.openid")).not.toBeNull();
    expect(screen.getByText("auth.oidcProvider.scopes.profile")).not.toBeNull();
    expect(screen.getByText("auth.oidcProvider.scopes.email")).not.toBeNull();
  });

  it("accepts or denies through the provider without constructing a redirect", async () => {
    const user = userEvent.setup();
    const { default: Page } = await import("./page");
    const first = render(<Page />);
    await screen.findByText("Dawarich Timeline");

    await user.click(screen.getByRole("button", { name: "auth.oidcProvider.accept" }));
    expect(consent).toHaveBeenCalledWith({ accept: true });

    first.unmount();
    consent.mockClear();
    render(<Page />);
    await screen.findByText("Dawarich Timeline");
    await user.click(screen.getByRole("button", { name: "auth.oidcProvider.deny" }));
    expect(consent).toHaveBeenCalledWith({ accept: false });
  });

  it("disables both choices and prevents double submission", async () => {
    let settle: ((value: unknown) => void) | undefined;
    consent.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const user = userEvent.setup();
    const { default: Page } = await import("./page");
    render(<Page />);
    await screen.findByText("Dawarich Timeline");

    const accept = screen.getByRole("button", { name: "auth.oidcProvider.accept" });
    const deny = screen.getByRole("button", { name: "auth.oidcProvider.deny" });
    await user.click(accept);

    expect((accept as HTMLButtonElement).disabled).toBe(true);
    expect((deny as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(accept);
    expect(consent).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle?.({ data: {}, error: null });
    });
  });

  it("fails safely for missing or invalid client context", async () => {
    window.history.replaceState({}, "", "/auth/oidc/consent");
    const { default: Page } = await import("./page");
    render(<Page />);

    expect(screen.getByRole("alert").textContent).toContain("auth.oidcProvider.invalidClient");
    expect(publicClient).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: "auth.oidcProvider.backToOpenMapX" }).getAttribute("href"),
    ).toBe("/");
  });

  it("does not render hostile query values or private client metadata", async () => {
    window.history.replaceState(
      {},
      "",
      "/auth/oidc/consent?client_id=%3Cscript%3Esteal()%3C%2Fscript%3E&scope=openid%20javascript%3Aalert(1)&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal",
    );
    publicClient.mockResolvedValue({
      data: {
        client_id: "server-value",
        client_name: "Safe client",
        client_uri: "https://safe.example/app",
        client_secret: "must-not-render",
        redirect_uris: ["https://private.example/callback"],
        metadata: { internal: "hidden" },
      },
      error: null,
    });
    const { default: Page } = await import("./page");
    render(<Page />);

    await screen.findByText("Safe client");
    await waitFor(() => expect(publicClient).toHaveBeenCalledTimes(1));
    expect(document.body.textContent).not.toContain("steal");
    expect(document.body.textContent).not.toContain("javascript");
    expect(document.body.textContent).not.toContain("must-not-render");
    expect(document.body.textContent).not.toContain("private.example");
    expect(document.body.textContent).not.toContain("hidden");
    expect(screen.getByText("auth.oidcProvider.scopes.openid")).not.toBeNull();
    expect(screen.queryByText("auth.oidcProvider.scopes.javascript:alert(1)")).toBeNull();
  });

  it("shows a safe error when the public-client lookup fails", async () => {
    publicClient.mockResolvedValue({ data: null, error: { message: "not found" } });
    const { default: Page } = await import("./page");
    render(<Page />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "auth.oidcProvider.invalidClient",
    );
    expect(document.body.textContent).not.toContain("not found");
  });
});
