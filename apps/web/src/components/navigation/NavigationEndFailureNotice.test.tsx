import { describe, expect, it, vi } from "vitest";
import { useNativeEndFailure } from "@/lib/mobile/nativeEndFailure";
import { act, render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { NavigationEndFailureNotice } from "./NavigationEndFailureNotice";

describe("NavigationEndFailureNotice", () => {
  it("says so when ending a native trip failed", () => {
    render(<NavigationEndFailureNotice />);
    expect(screen.queryByText("navigation.endFailed")).toBeNull();

    act(() => useNativeEndFailure.getState().report());

    expect(screen.getByText("navigation.endFailed")).toBeTruthy();
    act(() => useNativeEndFailure.getState().dismiss());
  });
});
