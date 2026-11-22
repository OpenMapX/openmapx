import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}));
const overlays = vi.hoisted(() => ({ registry: [] as { id: string }[] }));
vi.mock("@openmapx/core", () => ({
  get OVERLAY_REGISTRY() {
    return overlays.registry;
  },
  useNavigationStore: (sel: (s: unknown) => unknown) =>
    sel({ keepScreenOn: false, toggleKeepScreenOn: () => {} }),
  useLayerStore: (sel: (s: unknown) => unknown) =>
    sel({ activeLayer: "default", setActiveLayer: () => {} }),
}));

vi.mock("./navMenuRows", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  OverlayToggleRow: ({ label }: { label: string }) => <span>{label}</span>,
}));

import { NavMenu } from "./NavMenu";

const baseProps = {
  onOpenDirections: () => {},
  onOverview: () => {},
  onOpenSettings: () => {},
};

describe("NavMenu", () => {
  it("hides overlay toggles whose integration isn't registered", () => {
    const html = renderToStaticMarkup(<NavMenu {...baseProps} />);
    expect(html).not.toContain("menu.showTraffic");
    expect(html).not.toContain("menu.threeDView");
  });

  it("NavMenu shows the 3D view row under menu.threeDView", () => {
    overlays.registry = [{ id: "3d-buildings" }];
    try {
      const html = renderToStaticMarkup(<NavMenu {...baseProps} />);
      expect(html).toContain("menu.threeDView");
      expect(html).not.toContain("menu.showRaisedBuildings");
    } finally {
      overlays.registry = [];
    }
  });
});
