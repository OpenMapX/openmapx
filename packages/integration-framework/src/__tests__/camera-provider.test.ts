import type { Camera } from "@openmapx/mobility-core/camera";
import { describe, expect, test } from "vitest";
import type { CameraProvider } from "../contracts/camera-provider.js";
import { createMockIntegrationContext } from "../testing/index.js";

const camera: Camera = {
  id: "oc:feature:de-test-cameras:1",
  name: "Test camera",
  type: "traffic",
  coordinates: [13.4, 52.5],
  views: [
    {
      key: "0",
      status: "online",
      stale: false,
      imageUrl: "https://example.test/a.jpg",
      imageRedistribution: "allowed",
    },
  ],
  sources: ["de-test-cameras"],
  attributions: [],
};

describe("registerCameraProvider", () => {
  test("registerCameraProvider stores the provider under cameras", async () => {
    const ctx = createMockIntegrationContext();
    const provider: CameraProvider = {
      id: "test",
      coverage: { all: true },
      searchCameras: async () => ({ cameras: [camera] }),
      getCamera: async () => camera,
    };
    ctx.registerCameraProvider(provider);
    expect(ctx.registered.cameras).toEqual([provider]);
    await expect(ctx.registered.cameras[0]?.getCamera(camera.id)).resolves.toBe(camera);
  });
});
