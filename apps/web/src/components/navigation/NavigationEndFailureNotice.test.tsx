import { describe, expect, it, vi } from "vitest";
import { useNativeEndFailure } from "@/lib/mobile/nativeEndFailure";
import { act, render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { NavigationEndFailureNotice } from "./NavigationEndFailureNotice";

describe("NavigationEndFailureNotice", () => {
  it("says so when native refused to end the trip", () => {
    render(<NavigationEndFailureNotice />);
    expect(screen.queryByText("navigation.endFailed")).toBeNull();

    act(() => useNativeEndFailure.getState().report("refused"));

    expect(screen.getByText("navigation.endFailed")).toBeTruthy();
    act(() => useNativeEndFailure.getState().dismiss());
  });

  it("says the end is unconfirmed when native did not answer", () => {
    render(<NavigationEndFailureNotice />);

    act(() => useNativeEndFailure.getState().report("unconfirmed"));

    expect(screen.getByText("navigation.endUnconfirmed")).toBeTruthy();
    expect(screen.queryByText("navigation.endFailed")).toBeNull();
    act(() => useNativeEndFailure.getState().dismiss());
  });

  it("shows a fresh notice for a second failure while the first is showing", () => {
    render(<NavigationEndFailureNotice />);
    act(() => useNativeEndFailure.getState().report("refused"));
    const first = screen.getByText("navigation.endFailed").closest(".MuiSnackbar-root");

    act(() => useNativeEndFailure.getState().report("refused"));

    const second = screen.getByText("navigation.endFailed").closest(".MuiSnackbar-root");
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    act(() => useNativeEndFailure.getState().dismiss());
  });
});
