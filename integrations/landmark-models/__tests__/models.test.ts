import { type Mesh, MeshBasicMaterial } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelStore } from "../web/models";
import { makeGlb } from "./glb-fixture";

type Pending = { url: string; resolve: (response: Response) => void; reject: (e: unknown) => void };

function controlledFetch() {
  const pending: Pending[] = [];
  const fetchImpl = vi.fn(
    (url: string) =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ url, resolve, reject });
      }),
  );
  return { fetchImpl, pending };
}

const glbResponse = (options?: Parameters<typeof makeGlb>[0]) =>
  new Response(makeGlb(options), { status: 200 });

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

function firstMesh(store: ModelStore, asset: string, lod: "low" | "detail" = "low"): Mesh {
  let mesh: Mesh | undefined;
  store.get(asset, lod)?.scene.traverse((object) => {
    if ((object as Mesh).isMesh) mesh ??= object as Mesh;
  });
  return mesh as Mesh;
}

describe("ModelStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads at most 4 models at once", async () => {
    const { fetchImpl, pending } = controlledFetch();
    const store = new ModelStore({ apiUrl: "https://app.example", fetch: fetchImpl as never });
    for (let i = 0; i < 6; i++) store.request(`a${i}`, "low", `/m/${i}.glb`, i);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(pending.map((p) => p.url)).toEqual(
      [0, 1, 2, 3].map((i) => `https://app.example/m/${i}.glb`),
    );
    pending[0]?.resolve(glbResponse());
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    store.dispose();
  });

  it("serves detail only when ready and low until then", async () => {
    const { fetchImpl, pending } = controlledFetch();
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
    store.request("a", "low", "/low.glb", 0);
    pending[0]?.resolve(glbResponse());
    await settle();
    store.request("a", "detail", "/detail.glb", 0);
    expect(store.best("a", "detail")).toBe(store.get("a", "low"));
    pending[1]?.resolve(glbResponse({ size: 20 }));
    await settle();
    expect(store.best("a", "detail")).toBe(store.get("a", "detail"));
    expect(store.best("a", "low")).toBe(store.get("a", "low"));
    store.dispose();
  });

  it("evicts least recently touched beyond 80 models or the byte budget and disposes them", async () => {
    const fetchImpl = vi.fn(async () => glbResponse());
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never, maxResident: 2 });
    store.request("a", "low", "/a.glb", 0);
    store.request("b", "low", "/b.glb", 0);
    await settle();
    const disposed = vi.fn();
    firstMesh(store, "a").geometry.addEventListener("dispose", disposed);
    store.touch("b");
    store.request("c", "low", "/c.glb", 0);
    await settle();
    expect(store.get("a", "low")).toBeUndefined();
    expect(store.get("b", "low")).toBeDefined();
    expect(store.get("c", "low")).toBeDefined();
    expect(disposed).toHaveBeenCalled();
    store.dispose();
  });

  it("never evicts a nearer wanted model to admit a farther one", async () => {
    const fetchImpl = vi.fn(async () => glbResponse());
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never, maxResident: 2 });
    store.request("near", "low", "/near.glb", 0);
    store.request("mid", "low", "/mid.glb", 1);
    await settle();
    // Touch order must not matter: the map touches nearest first.
    store.touch("near");
    store.touch("mid");
    store.request("far", "low", "/far.glb", 2);
    await settle();
    expect(store.get("near", "low")).toBeDefined();
    expect(store.get("mid", "low")).toBeDefined();
    expect(store.get("far", "low")).toBeUndefined();
    store.dispose();
  });

  it("evicts models no longer wanted before wanted ones", async () => {
    const fetchImpl = vi.fn(async () => glbResponse());
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never, maxResident: 2 });
    store.request("old", "low", "/old.glb", 0);
    store.request("b", "low", "/b.glb", 1);
    await settle();
    store.touch("old");
    store.request("b", "low", "/b.glb", 0);
    store.request("c", "low", "/c.glb", 1);
    store.cancelExcept(new Set(["b", "c"]));
    await settle();
    expect(store.get("old", "low")).toBeUndefined();
    expect(store.get("b", "low")).toBeDefined();
    expect(store.get("c", "low")).toBeDefined();
    store.dispose();
  });

  it("a 404 skips only that model file, not a newer one of the same asset", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith("/old.glb") ? new Response("", { status: 404 }) : glbResponse(),
    );
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
    store.request("a", "detail", "/old.glb", 0);
    await settle();
    expect(store.failure("/old.glb")).toBe("skipped");
    store.request("a", "low", "/low.glb", 0);
    store.request("a", "detail", "/new.glb", 0);
    await settle();
    expect(store.get("a", "low")).toBeDefined();
    expect(store.get("a", "detail")).toBeDefined();
    store.dispose();
  });

  it("night shading leaves unlit materials alone", async () => {
    const fetchImpl = vi.fn(async () => glbResponse({ unlit: true }));
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
    store.request("a", "low", "/a.glb", 0);
    await settle();
    const mesh = firstMesh(store, "a");
    const day = mesh.material;
    expect(() => store.get("a", "low")?.setNight(true)).not.toThrow();
    expect(mesh.material).toBe(day);
    store.dispose();
  });

  it("skips a model after 404", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
    store.request("a", "low", "/a.glb", 0);
    await settle();
    expect(store.failure("/a.glb")).toBe("skipped");
    store.request("a", "low", "/a.glb", 0);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("retries after Retry-After on 503 at most three times", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 503, headers: { "retry-after": "5" } }),
    );
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
    store.request("a", "low", "/a.glb", 0);
    await settle();
    expect(store.failure("/a.glb")).toBe("retrying");
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(store.failure("/a.glb")).toBe("skipped");
    store.dispose();
  });

  it("retries other errors once after 30 s", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network");
    });
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
    store.request("a", "low", "/a.glb", 0);
    await settle();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.failure("/a.glb")).toBe("skipped");
    store.dispose();
  });

  it("night variant colours windows warm and keeps the day material", async () => {
    const fetchImpl = vi.fn(async () => glbResponse({ materialName: "window-glass" }));
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
    store.request("a", "low", "/a.glb", 0);
    await settle();
    const model = store.get("a", "low");
    const mesh = firstMesh(store, "a");
    const day = mesh.material;
    model?.setNight(true);
    expect(mesh.material).toBeInstanceOf(MeshBasicMaterial);
    expect((mesh.material as MeshBasicMaterial).vertexColors).toBe(true);
    const color = mesh.geometry.getAttribute("color");
    expect([color.getX(0), color.getY(0), color.getZ(0)]).toEqual(
      [1, 0.72, 0.4].map((v) => expect.closeTo(v, 5)),
    );
    model?.setNight(false);
    expect(mesh.material).toBe(day);
    expect(mesh.geometry.getAttribute("color")).toBeUndefined();
    store.dispose();
  });

  it("refuses models that reference external images or buffers", async () => {
    for (const option of [
      { externalImageUri: "https://third-party.example/texture.png" },
      { externalBufferUri: "https://third-party.example/extra.bin" },
    ]) {
      const fetchImpl = vi.fn(async () => glbResponse(option));
      const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
      store.request("a", "low", "/a.glb", 0);
      await settle();
      expect(store.failure("/a.glb")).toBe("skipped");
      expect(store.get("a", "low")).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      store.dispose();
    }
  });

  it("accepts embedded data URIs", async () => {
    const fetchImpl = vi.fn(async () =>
      glbResponse({ externalBufferUri: "data:application/octet-stream;base64,AAAAAA==" }),
    );
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
    store.request("a", "low", "/a.glb", 0);
    await settle();
    expect(store.get("a", "low")).toBeDefined();
    store.dispose();
  });

  it("exposes positions in model-root space for footprints", async () => {
    const fetchImpl = vi.fn(async () => glbResponse({ size: 7 }));
    const store = new ModelStore({ apiUrl: "", fetch: fetchImpl as never });
    store.request("a", "low", "/a.glb", 0);
    await settle();
    const positions = store.get("a", "low")?.positions as Float32Array;
    expect(positions).toHaveLength(12);
    expect(Math.max(...positions)).toBe(7);
    expect(store.get("a", "low")?.bytesEstimate).toBeGreaterThan(0);
    store.dispose();
  });
});
