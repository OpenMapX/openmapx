import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "@/test/query";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const capabilities = vi.fn(() => ({ osmContributionsEnabled: true }));
const session = vi.fn(() => ({ data: { user: { id: "u1" } } }));

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    useCapabilities: () => capabilities(),
    useSession: () => session(),
  };
});

const dialogProps = vi.fn();
vi.mock("./OsmContributionDialog", () => ({
  consumeContributeCallbackMarker: () => false,
  OsmContributionDialog: (props: Record<string, unknown>) => {
    dialogProps(props);
    return <div data-testid="osm-contribution-dialog" />;
  },
}));

vi.mock("@/components/auth/AuthDialog", () => ({
  AuthDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="auth-dialog" /> : null),
}));

const { OsmContributionEntry } = await import("./OsmContributionEntry");

function renderEntry(osmId: string | undefined) {
  return render(<OsmContributionEntry osmId={osmId} />, { wrapper: createQueryWrapper() });
}

beforeEach(() => {
  capabilities.mockReturnValue({ osmContributionsEnabled: true });
  session.mockReturnValue({ data: { user: { id: "u1" } } });
  dialogProps.mockClear();
});

describe("visibility", () => {
  it("renders for a valid node, way and relation reference", () => {
    for (const osmId of ["node/12", "way/42", "relation/7"]) {
      const { unmount } = renderEntry(osmId);
      expect(screen.getByTestId("osm-contribution-entry")).not.toBeNull();
      unmount();
    }
  });

  it("renders nothing without a usable OSM reference", () => {
    for (const osmId of [
      undefined,
      "",
      "osm:node/1",
      "https://www.openstreetmap.org/node/1",
      "node/0",
    ]) {
      const { container, unmount } = renderEntry(osmId);
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });

  it("stays hidden while the public feature bit is off or unknown", () => {
    capabilities.mockReturnValue({ osmContributionsEnabled: false });
    const { container } = renderEntry("node/12");
    expect(container.innerHTML).toBe("");
  });
});

describe("activation", () => {
  it("opens the sign-in dialog when signed out", async () => {
    session.mockReturnValue({ data: null } as never);
    renderEntry("node/12");
    await userEvent.click(screen.getByTestId("osm-contribution-entry"));
    expect(screen.getByTestId("auth-dialog")).not.toBeNull();
    expect(screen.queryByTestId("osm-contribution-dialog")).toBeNull();
  });

  it("opens the editor directly when signed in", async () => {
    renderEntry("node/12");
    await userEvent.click(screen.getByTestId("osm-contribution-entry"));
    expect(screen.getByTestId("osm-contribution-dialog")).not.toBeNull();
  });

  it("activates from the keyboard", async () => {
    renderEntry("node/12");
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("osm-contribution-dialog")).not.toBeNull();
  });
});

describe("editor input", () => {
  it("passes only the parsed OSM reference, never place content", async () => {
    renderEntry("way/42");
    await userEvent.click(screen.getByTestId("osm-contribution-entry"));
    const props = dialogProps.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props.ref_).toEqual({ type: "way", id: 42 });
    expect(Object.keys(props).sort()).toEqual(["onClose", "open", "ref_"]);
  });
});
