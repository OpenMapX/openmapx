import { useNavigationStore } from "@openmapx/core";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SheetFollowTrack } from "@/lib/sheetFollow";
import { NavSpeedLimitSlot } from "./NavSpeedLimitSlot";

const follow = vi.hoisted(() => ({ track: null as SheetFollowTrack | null }));
vi.mock("@/lib/sheetFollow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sheetFollow")>()),
  useSheetFollowTrack: () => follow.track,
}));

beforeEach(() => useNavigationStore.setState({ currentSpeedLimit: 30 }));
afterEach(() => {
  follow.track = null;
  useNavigationStore.setState({ currentSpeedLimit: null });
});

it("lifts the badge above the sheet by the published height without a driving sheet", () => {
  render(<NavSpeedLimitSlot isMobile sheetClearance={240} />);
  const slot = screen.getByTestId("nav-speed-limit");
  expect(getComputedStyle(slot).marginBottom).toBe("240px");
  expect(getComputedStyle(slot).animationName).toBe("none");
});

it("rides a driving sheet's top edge on the compositor instead of a per-frame margin", () => {
  follow.track = { scrollStart: 4, cap: 440, lift: 0, floor: 0 };
  render(<NavSpeedLimitSlot isMobile sheetClearance={240} />);
  const slot = screen.getByTestId("nav-speed-limit");
  expect(getComputedStyle(slot).marginBottom).toBe("0px");
  expect(getComputedStyle(slot).animationName).toBe("omx-sheet-follow");
});
