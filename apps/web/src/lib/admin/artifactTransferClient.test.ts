import { createApiClient } from "@openmapx/core";
import { afterEach, expect, it, vi } from "vitest";
import { downloadArtifactToSink, uploadArtifactFile } from "./artifactTransferClient";

const stageId = "9b0f4718-062d-4b5f-8048-55381380aeac";
const stage = {
  stageId,
  purpose: "prepared-artifact",
  direction: "upload",
  state: "uploaded",
  bytes: 4,
  sha256: "a".repeat(64),
  expiresAt: "2026-12-01T00:00:00.000Z",
  cleanup: "pending",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("uploads the original File through the supplied client without buffering and reports server progress", async () => {
  const file = new File([new Uint8Array([0, 255, 128, 7])], "graph.tar"),
    progress = vi.fn();
  Object.defineProperty(file, "arrayBuffer", {
    value: () => {
      throw Error("Whole-file read forbidden");
    },
  });
  const requests = vi.fn(async (_url, raw) => {
    const init = raw as RequestInit;
    if (init.method === "PUT") expect(init.body).toBe(file);
    return Response.json(stage);
  });
  vi.stubGlobal("fetch", requests);
  expect(
    await uploadArtifactFile({
      client: createApiClient({ baseUrl: "http://transfer.test" }),
      stageId,
      file,
      signal: new AbortController().signal,
      onProgress: progress,
    }),
  ).toMatchObject(stage);
  expect(
    requests.mock.calls.filter(([, init]) => (init as RequestInit).method === "PUT"),
  ).toHaveLength(1);
  expect(String(requests.mock.calls[0]?.[0])).toContain(
    "http://transfer.test/api/admin/artifact-transfers/",
  );
  expect(progress).toHaveBeenLastCalledWith({ receivedBytes: 4, state: "uploaded" });
});
it("reconciles a lost upload response by inspection rather than sending the body twice", async () => {
  const requests = vi.fn(async (_url, raw) => {
    const init = raw as RequestInit;
    if (init.method === "PUT") throw Error("Named lost response");
    return Response.json(stage);
  });
  vi.stubGlobal("fetch", requests);
  expect(
    await uploadArtifactFile({
      client: createApiClient({ baseUrl: "http://transfer.test" }),
      stageId,
      file: new File(["data"], "graph.tar"),
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ state: "uploaded" });
  expect(
    requests.mock.calls.filter(([, init]) => (init as RequestInit).method === "PUT"),
  ).toHaveLength(1);
});
it("streams non-UTF8 download bytes into the selected sink without Blob materialization", async () => {
  const blob = vi.spyOn(Response.prototype, "blob").mockRejectedValue(Error("No memory Blob"));
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array([0, 255, 128, 7]), {
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "4",
            "content-disposition": 'attachment; filename="openmapx-artifact.tar"',
            "x-artifact-sha256": "a".repeat(64),
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        }),
    ),
  );
  const chunks: Uint8Array[] = [];
  let closed = 0,
    aborted = 0;
  const write = async (chunk: Uint8Array) => {
      chunks.push(chunk);
    },
    close = async () => {
      closed++;
    },
    abort = async () => {
      aborted++;
    };
  await downloadArtifactToSink({
    client: createApiClient({ baseUrl: "http://transfer.test" }),
    stageId,
    sink: { write, close, abort },
    signal: new AbortController().signal,
  });
  expect(Array.from(chunks[0] ?? [])).toEqual([0, 255, 128, 7]);
  expect(closed).toBe(1);
  expect(aborted).toBe(0);
  expect(blob).not.toHaveBeenCalled();
});
