import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const mutateAsync = vi.fn();
const keypairState = { current: { data: null as unknown } };
vi.mock("@openmapx/mangrove-react", () => ({
  useUnlockKeypair: () => ({ mutateAsync, isPending: false }),
  useKeypairState: () => keypairState.current,
}));

import { MangroveUnlockDialog } from "./MangroveUnlockDialog";

interface Wrap {
  id: string;
  wrapType: "passphrase" | "webauthn";
  label: string;
  identityString: string | null;
  createdAt: string;
}

function readyEnvelope(wrapTypes: Array<"passphrase" | "webauthn">) {
  const wraps: Wrap[] = wrapTypes.map((wrapType, i) => ({
    id: `w${i}`,
    wrapType,
    label: wrapType,
    identityString: null,
    createdAt: "2026-01-01T00:00:00Z",
  }));
  return {
    data: {
      state: "ready",
      mode: "encrypted",
      publicJwk: {},
      passphraseCiphertext: null,
      recipientsCiphertext: null,
      wraps,
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  keypairState.current = { data: null };
});

describe("MangroveUnlockDialog", () => {
  it("shows the passphrase field for a passphrase-only envelope and no passkey button", () => {
    keypairState.current = readyEnvelope(["passphrase"]);
    render(<MangroveUnlockDialog open onClose={vi.fn()} />);

    expect(screen.queryByLabelText("account.mangrovePassphraseLabel")).not.toBe(null);
    expect(screen.queryByRole("button", { name: "account.mangroveUnlockWithPasskey" })).toBe(null);
  });

  it("shows the passkey button for a webauthn-only envelope and no passphrase field", () => {
    keypairState.current = readyEnvelope(["webauthn"]);
    render(<MangroveUnlockDialog open onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "account.mangroveUnlockWithPasskey" })).not.toBe(
      null,
    );
    expect(screen.queryByLabelText("account.mangrovePassphraseLabel")).toBe(null);
  });

  it("renders both unlock methods plus the divider when the envelope wraps both", () => {
    keypairState.current = readyEnvelope(["passphrase", "webauthn"]);
    render(<MangroveUnlockDialog open onClose={vi.fn()} />);

    expect(screen.queryByLabelText("account.mangrovePassphraseLabel")).not.toBe(null);
    expect(screen.queryByRole("button", { name: "account.mangroveUnlockWithPasskey" })).not.toBe(
      null,
    );
    expect(screen.queryByText("common.or")).not.toBe(null);
  });

  it("disables the unlock CTA until a passphrase is entered", async () => {
    const user = userEvent.setup();
    keypairState.current = readyEnvelope(["passphrase"]);
    render(<MangroveUnlockDialog open onClose={vi.fn()} />);

    const cta = screen.getByRole("button", { name: "account.mangroveUnlockCta" });
    expect((cta as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("account.mangrovePassphraseLabel"), "hunter2");
    expect((cta as HTMLButtonElement).disabled).toBe(false);
  });

  it("unlocks via passphrase and closes on success", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onUnlocked = vi.fn();
    mutateAsync.mockResolvedValue(undefined);
    keypairState.current = readyEnvelope(["passphrase"]);
    render(<MangroveUnlockDialog open onClose={onClose} onUnlocked={onUnlocked} />);

    await user.type(screen.getByLabelText("account.mangrovePassphraseLabel"), "hunter2");
    await user.click(screen.getByRole("button", { name: "account.mangroveUnlockCta" }));

    expect(mutateAsync).toHaveBeenCalledWith({ method: "passphrase", passphrase: "hunter2" });
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error message when unlocking fails", async () => {
    const user = userEvent.setup();
    mutateAsync.mockRejectedValue(new Error("wrong passphrase"));
    keypairState.current = readyEnvelope(["passphrase"]);
    render(<MangroveUnlockDialog open onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("account.mangrovePassphraseLabel"), "nope");
    await user.click(screen.getByRole("button", { name: "account.mangroveUnlockCta" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("wrong passphrase");
  });
});
