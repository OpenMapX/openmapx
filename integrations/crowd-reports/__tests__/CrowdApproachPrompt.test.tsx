// @vitest-environment jsdom

import type { IncidentAlert, NavProgress } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import {
  NavIncidentContext,
  type NavIncidentResource,
} from "@openmapx/integration-framework/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test";
import { CrowdApproachPrompt } from "../CrowdApproachPrompt";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

function crowdIncident(id: string, alongMeters: number): IncidentAlert {
  return {
    id: `crowd:${id}`,
    type: "traffic_incident",
    coord: [0, 0],
    alongMeters,
    eventType: "hazard",
    severity: "medium",
    headline: `Report ${id}`,
    geometry: { type: "Point", coordinates: [0, 0] },
    approach: { leadSec: 14, minM: 250, maxM: 1000 },
  };
}

function resourceWith(incidents: IncidentAlert[]): NavIncidentResource {
  return { incidents, status: "fresh", routeIdentity: null, successfulRevision: 1 };
}

function renderPrompt(incidents: IncidentAlert[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NavIncidentContext.Provider value={resourceWith(incidents)}>
        <CrowdApproachPrompt />
      </NavIncidentContext.Provider>
    </QueryClientProvider>,
  );
}

describe("CrowdApproachPrompt", () => {
  beforeEach(() => {
    useNavigationStore.setState({
      status: "navigating",
      progress: { alongMeters: 0, speedMps: 0 } as unknown as NavProgress,
    });
  });

  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
  });

  it("reads incidents from the shared nav-incident context, not a direct app import", () => {
    const { container } = renderPrompt([crowdIncident("42", 100)]);
    expect(screen.getByText("Report 42")).toBeInTheDocument();
    expect(container).not.toBeEmptyDOMElement();
  });

  it("renders nothing when no crowd-sourced report is within range", () => {
    const { container } = renderPrompt([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when not navigating, even with a report in range", () => {
    useNavigationStore.setState({ status: "idle" });
    const { container } = renderPrompt([crowdIncident("42", 100)]);
    expect(container).toBeEmptyDOMElement();
  });

  it("throws when rendered outside the nav-incident provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    expect(() =>
      render(
        <QueryClientProvider client={client}>
          <CrowdApproachPrompt />
        </QueryClientProvider>,
      ),
    ).toThrow(/useNavIncidentResource must be used within/);
    consoleError.mockRestore();
  });
});
