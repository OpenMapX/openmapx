import type { OsmContributionCapabilities } from "@openmapx/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const link = vi.fn();
vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return { ...actual, authClient: { linkSocial: (input: unknown) => link(input) } };
});

const { callbackUrlFor, linkScopesFor, OsmContributionGate } = await import(
  "./OsmContributionGate"
);

const BASE: OsmContributionCapabilities = {
  enabled: true,
  directEditingEnabled: true,
  linked: true,
  canWriteApi: true,
  canWriteNotes: true,
  contributorTermsAgreed: true,
  activeBlock: false,
  requiredScopes: [],
  actions: { reauthorize: false },
};

function renderGate(
  capabilities: OsmContributionCapabilities | undefined,
  overrides: Partial<Parameters<typeof OsmContributionGate>[0]> = {},
) {
  return render(
    <OsmContributionGate
      intent="edit"
      capabilities={capabilities}
      isLoading={false}
      isError={false}
      hasUnsentInput={false}
      onRetry={() => {}}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  link.mockClear();
});

describe("linkScopesFor", () => {
  it("always carries base identity plus the intended action", () => {
    expect(linkScopesFor("edit")).toEqual(["openid", "read_prefs", "write_api"]);
    expect(linkScopesFor("note")).toEqual(["openid", "read_prefs", "write_notes"]);
  });

  it("is deterministic and de-duplicated", () => {
    const scopes = linkScopesFor("edit");
    expect(scopes).toEqual(["openid", "read_prefs", "write_api"]);
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});

describe("callbackUrlFor", () => {
  it("adds only a boolean marker to the same-origin URL", () => {
    const url = new URL(callbackUrlFor("https://maps.example/place/node%2F12?tab=overview"));
    expect(url.origin).toBe("https://maps.example");
    expect(url.searchParams.get("osm-contribute")).toBe("1");
    expect(url.searchParams.get("tab")).toBe("overview");
    expect([...url.searchParams.keys()].sort()).toEqual(["osm-contribute", "tab"]);
  });

  it("never carries a draft, element reference or comment", () => {
    const url = callbackUrlFor("https://maps.example/");
    expect(/comment|source|node|way|relation|tag/i.test(url)).toBe(false);
  });
});

describe("gate states", () => {
  it("shows a loading state", () => {
    renderGate(BASE, { isLoading: true });
    expect(screen.getByText("osmContributions.loading")).not.toBeNull();
  });

  it("shows an unavailable state on error", () => {
    renderGate(undefined, { isError: true });
    expect(screen.getByText("osmContributions.gateUnavailableTitle")).not.toBeNull();
  });

  it("asks to link an account", async () => {
    renderGate({ ...BASE, linked: false, canWriteApi: false, canWriteNotes: false });
    await userEvent.click(screen.getByText("osmContributions.gateLinkAction"));
    expect(link).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openstreetmap",
        scopes: ["openid", "read_prefs", "write_api"],
      }),
    );
  });

  it("asks for the missing action scope", async () => {
    renderGate({ ...BASE, canWriteApi: false });
    await userEvent.click(screen.getByText("osmContributions.gateScopeAction"));
    expect(link).toHaveBeenCalledWith(
      expect.objectContaining({
        scopes: ["openid", "read_prefs", "write_api"],
      }),
    );
  });

  it("surfaces the trusted contributor-terms and block links only", () => {
    const { unmount } = renderGate({
      ...BASE,
      contributorTermsAgreed: false,
      actions: {
        reauthorize: true,
        contributorTermsUrl: "https://www.openstreetmap.org/user/terms",
      },
    });
    expect(
      screen.getByText("osmContributions.gateTermsAction").closest("a")?.getAttribute("href"),
    ).toBe("https://www.openstreetmap.org/user/terms");
    unmount();

    renderGate({
      ...BASE,
      activeBlock: true,
      actions: {
        reauthorize: false,
        accountMessagesUrl: "https://www.openstreetmap.org/messages/inbox",
      },
    });
    expect(
      screen.getByText("osmContributions.gateBlockedAction").closest("a")?.getAttribute("href"),
    ).toBe("https://www.openstreetmap.org/messages/inbox");
  });

  it("offers re-authorization, not a dead end, when the token is unusable", () => {
    // `reauthorization_required` reports linked with the conservative defaults
    // and no action URL; the terms panel would have rendered no button at all.
    renderGate({
      ...BASE,
      canWriteApi: false,
      canWriteNotes: false,
      contributorTermsAgreed: false,
      requiredScopes: ["write_api", "write_notes"],
      actions: { reauthorize: true },
    });
    expect(screen.getByText("osmContributions.gateScopeAction")).not.toBeNull();
    expect(screen.queryByText("osmContributions.gateTermsTitle")).toBeNull();
  });

  it("still shows the terms panel when OpenStreetMap actually reported them", () => {
    renderGate({
      ...BASE,
      contributorTermsAgreed: false,
      actions: {
        reauthorize: true,
        contributorTermsUrl: "https://www.openstreetmap.org/user/terms",
      },
    });
    expect(screen.getByText("osmContributions.gateTermsTitle")).not.toBeNull();
  });

  it("explains the direct-editing kill switch without offering an edit", () => {
    renderGate({ ...BASE, directEditingEnabled: false });
    expect(screen.getByText("osmContributions.errorDirectEditingDisabled")).not.toBeNull();
  });

  it("warns before navigating away with unsent input", () => {
    renderGate({ ...BASE, canWriteApi: false }, { hasUnsentInput: true });
    expect(screen.getByText("osmContributions.gateDiscardWarning")).not.toBeNull();
  });

  it("renders nothing once every gate is satisfied", () => {
    const { container } = renderGate(BASE);
    expect(container.innerHTML).toBe("");
  });
});
