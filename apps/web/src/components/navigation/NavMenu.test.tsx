import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}));
vi.mock("@openmapx/core", () => ({
  OVERLAY_REGISTRY: [],
  useNavigationStore: (sel: (s: unknown) => unknown) =>
    sel({ keepScreenOn: false, toggleKeepScreenOn: () => {} }),
  useLayerStore: (sel: (s: unknown) => unknown) =>
    sel({ activeLayer: "default", setActiveLayer: () => {} }),
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
    expect(html).not.toContain("menu.showRaisedBuildings");
  });
});
