import type { Place } from "@openmapx/core";
import { useDirectionsStore, useSidebarStore } from "@openmapx/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "@/test/query";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useSession: () => ({ data: null }),
    useIsSaved: () => ({ data: [] }),
  };
});
vi.mock("@/components/auth/AuthDialog", () => ({
  AuthDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="auth-dialog" /> : null),
}));
vi.mock("@/components/panels/saved/SavePlaceDialog", () => ({
  SavePlaceDialog: () => null,
}));
const share = vi.fn(async () => "copied");
vi.mock("@/lib/deepLink", () => ({ shareCurrentUrl: (...args: unknown[]) => share(...args) }));

import { PlaceActionButtons } from "./PlaceActionButtons";

const place = {
  id: "osm:node:1",
  name: "Aachen",
  coordinates: [6.08, 50.77],
  category: "city",
} as Place;

beforeEach(() => {
  share.mockClear();
  useDirectionsStore.getState().close();
  useSidebarStore.getState().closeSidebar();
});

describe("PlaceActionButtons keyboard actions", () => {
  it("offers four native buttons and opens sign-in from Save with Space", async () => {
    const user = userEvent.setup();
    render(<PlaceActionButtons place={place} />, { wrapper: createQueryWrapper() });
    expect(screen.getAllByRole("button")).toHaveLength(4);
    const save = screen.getByRole("button", { name: "place.savePlace" });
    save.focus();
    await user.keyboard(" ");
    expect(screen.getByTestId("auth-dialog")).toBeDefined();
  });

  it("activates Directions and Share from the keyboard", async () => {
    const user = userEvent.setup();
    render(<PlaceActionButtons place={place} />, { wrapper: createQueryWrapper() });
    screen.getByRole("button", { name: "place.directions" }).focus();
    await user.keyboard("{Enter}");
    expect(useDirectionsStore.getState().waypoints.at(-1)?.label).toBe("Aachen");
    screen.getByRole("button", { name: "place.share" }).focus();
    await user.keyboard(" ");
    expect(share).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("place.linkCopied")).toBeDefined();
  });
});
