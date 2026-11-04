import { useNavigationStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import {
  applyCarCamera,
  attachCarHost,
  carLabelSize,
  carLayout,
  createCarSnapshotReceiver,
  routeLetter,
} from "./carSurface";
import { fixtureSnapshot } from "./harness";

describe("car surface", () => {
  beforeEach(() =>
    useNavigationStore.setState({
      status: "idle",
      cameraMode: "follow",
      nativeSessionId: null,
      nativeRevision: null,
    }),
  );
  it("stays inert without a host", () => {
    const receive = vi.fn();
    attachCarHost(undefined, receive)();
    expect(receive).not.toHaveBeenCalled();
  });
  it("listens before ready, validates messages, detaches", () => {
    const receive = vi.fn();
    const host = {
      postMessage: vi.fn(),
      onmessage: null as null | ((e: { data: string }) => void),
    };
    const detach = attachCarHost(host, receive);
    expect(host.postMessage).toHaveBeenCalledWith('{"v":1,"type":"car-ready"}');
    host.onmessage?.({ data: '{"v":1,"type":"car-camera","action":"recenter"}' });
    host.onmessage?.({ data: '{"v":2,"type":"car-camera","action":"recenter"}' });
    expect(receive).toHaveBeenCalledTimes(1);
    detach();
    expect(host.onmessage).toBeNull();
  });
  it.each([
    [1280, 720],
    [800, 480],
    [400, 480],
    [640, 720],
    [800, 240],
    [720, 1280],
  ])("keeps padding within stable area %sx%s", (width, height) => {
    const stable = { top: 24, right: 80, bottom: 24, left: 100 };
    const layout = carLayout({
      v: 1,
      type: "car-viewport",
      width,
      height,
      stable,
      visible: stable,
      dark: false,
    });
    expect(layout.padding.left).toBeGreaterThanOrEqual(100);
    expect(layout.padding.right).toBeGreaterThanOrEqual(80);
    expect(layout.padding.top + layout.padding.bottom).toBeLessThan(height - 40);
    if (width === 400 || height === 240) expect(layout.maxPitch).toBe(25);
  });
  it("applies full/progress through phone store and refuses revision gaps", () => {
    const error = vi.fn();
    const receive = createCarSnapshotReceiver(error);
    const fixture = fixtureSnapshot();
    if (fixture.type !== "car-snapshot") throw Error();
    receive(fixture.message);
    expect(useNavigationStore.getState().status).toBe("navigating");
    receive({
      ...fixture.message,
      type: "snapshot.update",
      payload: {
        snapshot: {
          type: "progress",
          sessionId: "car-fixture",
          revision: 3,
          routeFingerprint: "fixture-route",
        },
      },
    });
    expect(error).toHaveBeenCalledWith("snapshot-gap");
    expect(useNavigationStore.getState().nativeRevision).toBe(1);
  });
  it("pan leaves follow and recenter returns to it", () => {
    const { map } = createFakeMap();
    map.panBy = () => map;
    applyCarCamera(map, { v: 1, type: "car-camera", action: "pan", dx: 30, dy: 20 });
    expect(useNavigationStore.getState().cameraMode).toBe("free");
    applyCarCamera(map, { v: 1, type: "car-camera", action: "recenter" });
    expect(useNavigationStore.getState().cameraMode).toBe("follow");
  });
  it("frames the rest of the trip for the route overview", () => {
    const { map } = createFakeMap();
    const fitBounds = vi.fn();
    map.fitBounds = fitBounds as never;
    map.setPadding = (() => map) as never;
    useNavigationStore.setState({
      route: {
        geometry: [
          [6, 50],
          [7, 50.5],
          [13.4, 52.5],
        ],
      } as never,
      progress: { snapped: [6.5, 50.2], segmentIndex: 0 } as never,
    });
    applyCarCamera(map, { v: 1, type: "car-camera", action: "overview" });
    expect(useNavigationStore.getState().cameraMode).toBe("overview");
    // From the car's position on, not the part already driven.
    expect(fitBounds.mock.calls[0]?.[0]).toEqual([
      [6.5, 50.2],
      [13.4, 52.5],
    ]);
  });
  it("clears the map after matching terminal state and rejects malformed full routes", () => {
    const error = vi.fn();
    const receive = createCarSnapshotReceiver(error);
    const fixture = fixtureSnapshot();
    if (fixture.type !== "car-snapshot") throw Error();
    receive(fixture.message);
    receive({
      protocolVersion: 3,
      type: "session.stopped",
      messageId: "stop",
      channelNonce: "c",
      sentAtMs: 0,
      payload: { sessionId: "car-fixture", revision: 2, finalStatus: "stopped" },
    });
    expect(useNavigationStore.getState().status).toBe("idle");
    // The ended trip's route and position must not stay drawn on the car map.
    expect(useNavigationStore.getState().route).toBeNull();
    expect(useNavigationStore.getState().progress).toBeNull();
    expect(useNavigationStore.getState().nativeSessionId).toBeNull();
    if (fixture.message.type !== "snapshot.update") throw Error();
    receive({
      ...fixture.message,
      payload: {
        snapshot: { ...fixture.message.payload.snapshot, route: { geometry: "invalid" } },
      },
    });
    expect(error).toHaveBeenCalledWith("invalid-snapshot");
  });
});

describe("route preview labels", () => {
  it("letters routes in list order", () => {
    expect([0, 1, 2].map(routeLetter)).toEqual(["A", "B", "C"]);
  });
});

describe("car label sizes", () => {
  it("enlarges plain labels and scales shield text with its shield", () => {
    expect(carLabelSize({ "text-field": "{name}", "text-size": 12 })).toEqual({ textSize: 24 });
    expect(
      carLabelSize({
        "text-field": "{ref}",
        "text-size": 10,
        "icon-image": "road_yellow_{ref_length}",
        "icon-size": 1,
      }),
    ).toEqual({ textSize: 16, iconSize: 1.6 });
  });
});
