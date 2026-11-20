import { ApiClientError } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test";
import { planState, RouteResultStates } from "./RouteResultStates";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const empty = (data: { routes: unknown[] }) => data.routes.length === 0;
const recovery = {
  onEditOrigin: vi.fn(),
  onEditDestination: vi.fn(),
  modes: ["walking" as const],
  onSelectMode: vi.fn(),
};

describe("planState", () => {
  it("is loading until an answer arrives, and again while a failed plan retries", () => {
    expect(planState({ data: undefined, isLoading: true, isError: false }, empty).status).toBe(
      "loading",
    );
    expect(planState({ data: undefined, isLoading: false, isError: false }, empty).status).toBe(
      "loading",
    );
    expect(
      planState({ data: undefined, isLoading: false, isError: true, isFetching: true }, empty)
        .status,
    ).toBe("loading");
  });

  it("reports the failure over a previous answer, then an empty or ready answer", () => {
    expect(
      planState({ data: { routes: [1] }, isLoading: false, isError: true }, empty).status,
    ).toBe("error");
    expect(
      planState({ data: { routes: [] }, isLoading: false, isError: false }, empty).status,
    ).toBe("empty");
    expect(
      planState({ data: { routes: [1] }, isLoading: false, isError: false }, empty).status,
    ).toBe("ready");
  });

  it("retries through the query", () => {
    const refetch = vi.fn();
    planState({ data: undefined, isLoading: false, isError: true, refetch }, empty).retry();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("RouteResultStates", () => {
  const state = (status: "loading" | "error" | "empty" | "ready", error?: unknown) => ({
    status,
    error,
    retry: vi.fn(),
  });

  it("shows a spinner while planning and the results once ready", () => {
    const { rerender } = render(
      <RouteResultStates state={state("loading")} recovery={recovery}>
        <p>Routes</p>
      </RouteResultStates>,
    );
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.queryByText("Routes")).toBeNull();
    rerender(
      <RouteResultStates state={state("ready")} recovery={recovery}>
        <p>Routes</p>
      </RouteResultStates>,
    );
    expect(screen.getByText("Routes")).toBeTruthy();
  });

  it("offers a retry on failure, naming an unavailable service", () => {
    const failed = state("error", new ApiClientError(503, null, null));
    render(<RouteResultStates state={failed} recovery={recovery} />);
    expect(screen.getByText("directions.routeServiceUnavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(failed.retry).toHaveBeenCalledTimes(1);
  });

  it("offers other ends and modes for an empty answer", () => {
    render(<RouteResultStates state={state("empty")} recovery={recovery} />);
    expect(screen.getByText("directions.noRoutesFound")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "directions.changeOrigin" }));
    fireEvent.click(screen.getByRole("button", { name: /directions\.tryMode/ }));
    expect(recovery.onEditOrigin).toHaveBeenCalledTimes(1);
    expect(recovery.onSelectMode).toHaveBeenCalledWith("walking");
  });
});
