import { useNavigationStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";

const state = vi.hoisted(() => ({ saveHere: vi.fn(async () => "saved" as const) }));

vi.mock("@/components/panels/parking/useSaveParking", () => ({
  useSaveParking: () => ({ saveHere: state.saveHere, saveAt: vi.fn(), isSaving: false }),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { ArrivalCard } from "./ArrivalCard";

beforeEach(() => {
  state.saveHere.mockClear();
  useNavigationStore.setState({ kind: "ground", mode: "driving" });
});

describe("ArrivalCard", () => {
  it("offers Save parking after a drive", () => {
    render(<ArrivalCard onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /parking.saveParking/ })).toBeInTheDocument();
  });

  it("offers it after a motorcycle trip", () => {
    useNavigationStore.setState({ kind: "ground", mode: "motorcycle" });
    render(<ArrivalCard onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /parking.saveParking/ })).toBeInTheDocument();
  });

  it("hides it after a walk", () => {
    useNavigationStore.setState({ kind: "ground", mode: "walking" });
    render(<ArrivalCard onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /parking.saveParking/ })).toBeNull();
  });

  it("hides it for a transit arrival", () => {
    useNavigationStore.setState({ kind: "transit", mode: "driving" });
    render(<ArrivalCard onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /parking.saveParking/ })).toBeNull();
  });

  it("labels the save as an arrival and never saves without a press", async () => {
    render(<ArrivalCard onClose={() => {}} />);
    expect(state.saveHere).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /parking.saveParking/ }));
    await waitFor(() => expect(state.saveHere).toHaveBeenCalledWith({ source: "arrival" }));
  });

  it("keeps Done as the primary action", async () => {
    const onClose = vi.fn();
    render(<ArrivalCard onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "navigation.done" }));
    expect(onClose).toHaveBeenCalled();
  });
});
