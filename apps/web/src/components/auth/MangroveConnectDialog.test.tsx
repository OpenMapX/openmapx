import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
const local = vi.fn();
const state = {
  config: { configured: true },
  status: "disconnected",
  controller: { selectLocal: local, beginLogin: vi.fn() },
};
vi.mock("@openmapx/mangrove-react", () => ({
  useMangroveSigner: () => state,
  useKeypairStore: { getState: () => ({ lock: () => {} }) },
}));

import { MangroveConnectDialog } from "./MangroveConnectDialog";

describe("Mangrove connection choices", () => {
  it("offers the three shared login choices and explicit local signing", () => {
    render(<MangroveConnectDialog open onClose={() => {}} onLocal={() => {}} />);
    for (const key of [
      "mangroveLoginPasskey",
      "mangroveLoginOsm",
      "mangroveLoginBluesky",
      "mangroveUseLocal",
    ])
      expect(screen.getByRole("button", { name: `account.${key}` })).toBeTruthy();
  });
  it("shows unavailable registration while retaining the local choice", async () => {
    state.config = { configured: false };
    render(<MangroveConnectDialog open onClose={() => {}} onLocal={() => {}} />);
    expect(screen.getByText("account.mangroveSignerUnavailable")).toBeTruthy();
    const button = screen.getByRole("button", { name: "account.mangroveLoginOsm" });
    expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "account.mangroveUseLocal" }));
    expect(local).toHaveBeenCalled();
  });
});
