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
let authCallbackPath: string | undefined;
vi.mock("./OsmContributionDialog", () => ({
  consumeContributeCallbackMarker: () => false,
  OsmContributionDialog: (props: Record<string, unknown>) => {
    dialogProps(props);
    return <div data-testid="osm-contribution-dialog" />;
  },
}));

vi.mock("@/components/auth/AuthDialog", () => ({
  AuthDialog: (props: {
    open: boolean;
    onClose: () => void;
    onAuthenticated?: () => void;
    callbackPath?: string;
  }) => {
    authCallbackPath = props.callbackPath;
    return props.open ? (
      <div data-testid="auth-dialog">
        <button type="button" onClick={props.onClose}>
          Cancel authentication
        </button>
        <button type="button" onClick={props.onAuthenticated}>
          Complete authentication
        </button>
      </div>
    ) : null;
  },
}));

const { OsmContributionEntry } = await import("./OsmContributionEntry");

function renderEntry(osmId: string | undefined) {
  return render(<OsmContributionEntry osmId={osmId} />, { wrapper: createQueryWrapper() });
}

beforeEach(() => {
  capabilities.mockReturnValue({ osmContributionsEnabled: true });
  session.mockReturnValue({ data: { user: { id: "u1" } } });
  dialogProps.mockClear();
  authCallbackPath = undefined;
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
  it("continues when the session arrives while authentication is still open", async () => {
    session.mockReturnValue({ data: null } as never);
    const view = renderEntry("node/12");
    await userEvent.click(screen.getByTestId("osm-contribution-entry"));
    session.mockReturnValue({ data: { user: { id: "u1" } } });
    view.rerender(<OsmContributionEntry osmId="node/12" />);
    expect(await screen.findByTestId("osm-contribution-dialog")).not.toBeNull();
    expect(screen.queryByTestId("auth-dialog")).toBeNull();
  });

  it("continues when the session arrives after successful authentication closes", async () => {
    session.mockReturnValue({ data: null } as never);
    const view = renderEntry("node/12");
    await userEvent.click(screen.getByTestId("osm-contribution-entry"));
    await userEvent.click(screen.getByText("Complete authentication"));
    expect(screen.queryByTestId("osm-contribution-dialog")).toBeNull();
    session.mockReturnValue({ data: { user: { id: "u1" } } });
    view.rerender(<OsmContributionEntry osmId="node/12" />);
    expect(await screen.findByTestId("osm-contribution-dialog")).not.toBeNull();
    expect(screen.queryByTestId("auth-dialog")).toBeNull();
  });

  it("does not resume after authentication is cancelled", async () => {
    session.mockReturnValue({ data: null } as never);
    const view = renderEntry("node/12");
    await userEvent.click(screen.getByTestId("osm-contribution-entry"));
    await userEvent.click(screen.getByText("Cancel authentication"));
    session.mockReturnValue({ data: { user: { id: "u1" } } });
    view.rerender(<OsmContributionEntry osmId="node/12" />);
    expect(screen.queryByTestId("osm-contribution-dialog")).toBeNull();
  });

  it("clears authentication intent when the selected place changes", async () => {
    session.mockReturnValue({ data: null } as never);
    const view = renderEntry("node/12");
    await userEvent.click(screen.getByTestId("osm-contribution-entry"));
    view.rerender(<OsmContributionEntry osmId="way/42" />);
    expect(screen.queryByTestId("auth-dialog")).toBeNull();
    session.mockReturnValue({ data: { user: { id: "u1" } } });
    view.rerender(<OsmContributionEntry osmId="way/42" />);
    expect(screen.queryByTestId("osm-contribution-dialog")).toBeNull();
  });

  it("keeps the selected place in the content-free social callback", async () => {
    window.history.replaceState(
      null,
      "",
      "/?place=osm%3Anode%3A12&at=13.4%2C52.5#map=16/52.5/13.4",
    );
    session.mockReturnValue({ data: null } as never);
    renderEntry("node/12");
    await userEvent.click(screen.getByTestId("osm-contribution-entry"));
    expect(authCallbackPath).toBe(
      "/?place=osm%3Anode%3A12&at=13.4%2C52.5&osm-contribute=1#map=16/52.5/13.4",
    );
    window.history.replaceState(null, "", "/");
  });

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
