import { useNavigationStore } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { getCameraPaddingTarget, subscribeCameraPaddingTarget } from "./cameraPadding";
import { publishMapObstruction } from "./mapObstructions";

const OBSTRUCTION_IDS = ["panel", "sheet"];

afterEach(() => {
  for (const id of OBSTRUCTION_IDS) publishMapObstruction(id, "left", null);
  useNavigationStore.setState({
    status: "idle",
    kind: "ground",
    cameraMode: "follow",
    weakGps: false,
  });
});

describe("getCameraPaddingTarget", () => {
  it("reads the registry insets and the map's own container box", () => {
    const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800 });
    publishMapObstruction("panel", "left", 400);
    publishMapObstruction("sheet", "top", 72);
    expect(getCameraPaddingTarget(fake.map)).toEqual({ top: 72, bottom: 0, left: 400, right: 0 });
  });

  it("clamps against the container size rather than the window", () => {
    const fake = createFakeMap({ containerWidth: 1000, containerHeight: 800 });
    publishMapObstruction("panel", "left", 800);
    publishMapObstruction("sheet", "right", 200);
    const padding = getCameraPaddingTarget(fake.map);
    expect(padding.left + padding.right).toBe(700);
    expect(padding.left / padding.right).toBeCloseTo(4, 5);
  });

  it("adds the puck offset for ground navigation except in overview", () => {
    const fake = createFakeMap({ containerWidth: 1200, containerHeight: 800 });
    publishMapObstruction("sheet", "bottom", 200);
    useNavigationStore.setState({ status: "navigating", kind: "ground", cameraMode: "follow" });
    expect(getCameraPaddingTarget(fake.map)).toEqual({ top: 300, bottom: 200, left: 0, right: 0 });
    useNavigationStore.setState({ cameraMode: "free" });
    expect(getCameraPaddingTarget(fake.map).top).toBe(300);
    useNavigationStore.setState({ cameraMode: "overview" });
    expect(getCameraPaddingTarget(fake.map)).toEqual({ top: 0, bottom: 200, left: 0, right: 0 });
    useNavigationStore.setState({ cameraMode: "follow", kind: "transit" });
    expect(getCameraPaddingTarget(fake.map).top).toBe(0);
    useNavigationStore.setState({ status: "idle", kind: "ground" });
    expect(getCameraPaddingTarget(fake.map).top).toBe(0);
  });
});

describe("subscribeCameraPaddingTarget", () => {
  it("fires on an obstruction change, a navigation change, and a map resize", () => {
    const fake = createFakeMap();
    const listener = vi.fn();
    const unsubscribe = subscribeCameraPaddingTarget(fake.map, listener);

    publishMapObstruction("panel", "left", 400);
    expect(listener).toHaveBeenCalledTimes(1);

    useNavigationStore.setState({ status: "navigating" });
    expect(listener).toHaveBeenCalledTimes(2);

    useNavigationStore.setState({ kind: "transit" });
    expect(listener).toHaveBeenCalledTimes(3);

    useNavigationStore.setState({ cameraMode: "overview" });
    expect(listener).toHaveBeenCalledTimes(4);

    fake.emit("resize");
    expect(listener).toHaveBeenCalledTimes(5);

    unsubscribe();
  });

  it("ignores navigation changes that cannot move the padding", () => {
    const fake = createFakeMap();
    const listener = vi.fn();
    const unsubscribe = subscribeCameraPaddingTarget(fake.map, listener);
    useNavigationStore.setState({ weakGps: true });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("drops all three subscriptions when unsubscribed", () => {
    const fake = createFakeMap();
    const listener = vi.fn();
    const unsubscribe = subscribeCameraPaddingTarget(fake.map, listener);
    unsubscribe();

    publishMapObstruction("panel", "left", 400);
    useNavigationStore.setState({ status: "navigating", kind: "transit", cameraMode: "overview" });
    fake.emit("resize");
    expect(listener).not.toHaveBeenCalled();

    const resize = fake.state.listenerCalls.filter((call) => call.event === "resize");
    expect(resize.map((call) => call.method)).toEqual(["on", "off"]);
    expect(resize[1].handler).toBe(resize[0].handler);
    expect(fake.state.handlers.get("resize")?.size ?? 0).toBe(0);
  });
});
