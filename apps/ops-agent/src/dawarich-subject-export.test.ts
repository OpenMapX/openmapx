import { Readable } from "node:stream";
import {
  DAWARICH_SUPPORTED_COMMIT,
  DAWARICH_SUPPORTED_IMAGE,
  DAWARICH_SUPPORTED_IMAGE_DIGEST,
} from "@openmapx/core/privacy";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  createDockerDawarichRuntimeInspector,
  registerDawarichSubjectExportRoute,
} from "./dawarich-subject-export";

const request = {
  version: 1 as const,
  requestId: "00000000-0000-4000-8000-000000000001",
  openmapxSubjectId: "subject-1",
  expectedDawarichUserId: null,
  cutoff: "2026-09-04T10:00:00.000Z",
  rights: ["access"] as const,
};

describe("managed Dawarich subject export", () => {
  it("keeps the collector route fixed and streams a bounded response", async () => {
    const app = Fastify({ logger: false });
    registerDawarichSubjectExportRoute(app, {
      apiToken: "api-token",
      inspectRuntime: async () => ({
        image: DAWARICH_SUPPORTED_IMAGE,
        digest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
        commit: DAWARICH_SUPPORTED_COMMIT,
      }),
      runCollector: async (received) => {
        expect(received.openmapxSubjectId).toBe(request.openmapxSubjectId);
        return Readable.from([Buffer.from("tar")]);
      },
    });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/v1/privacy/dawarich-subject-export",
      headers: {
        authorization: "Bearer api-token",
        "x-ops-request-id": "ops1_request000000000001",
      },
      payload: request,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/vnd.openmapx.dawarich-subject-tar.v1",
    );
    expect(response.body).toBe("tar");
  });

  it("rejects an image or revision drift before running the collector", async () => {
    const app = Fastify({ logger: false });
    let called = false;
    registerDawarichSubjectExportRoute(app, {
      apiToken: "api-token",
      inspectRuntime: async () => ({
        image: DAWARICH_SUPPORTED_IMAGE,
        digest: `sha256:${"b".repeat(64)}`,
        commit: DAWARICH_SUPPORTED_COMMIT,
      }),
      runCollector: async () => {
        called = true;
        return Readable.from([Buffer.from("never")]);
      },
    });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/v1/privacy/dawarich-subject-export",
      headers: { authorization: "Bearer api-token" },
      payload: request,
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: "unsupported_version" });
    expect(called).toBe(false);
  });

  it("aborts and destroys a collector that exceeds the streaming byte bound", async () => {
    const app = Fastify({ logger: false });
    let source!: Readable;
    let collectorSignal!: AbortSignal;
    registerDawarichSubjectExportRoute(app, {
      apiToken: "api-token",
      maxOutputBytes: 4,
      runCollector: async (_request, signal) => {
        collectorSignal = signal;
        source = Readable.from([Buffer.from("1234"), Buffer.from("5")]);
        return source;
      },
    });
    await app.ready();
    await expect(
      app.inject({
        method: "POST",
        url: "/v1/privacy/dawarich-subject-export",
        headers: { authorization: "Bearer api-token" },
        payload: request,
      }),
    ).rejects.toMatchObject({ code: "LIGHT_ECONNRESET" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(collectorSignal.aborted).toBe(true);
    expect(source.destroyed).toBe(true);
  });

  it("does not consume a request id when a different request is already running", async () => {
    const app = Fastify({ logger: false });
    let started!: () => void;
    let release!: () => void;
    const collectorStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const collectorRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerDawarichSubjectExportRoute(app, {
      apiToken: "api-token",
      inspectRuntime: async () => ({
        image: DAWARICH_SUPPORTED_IMAGE,
        digest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
        commit: DAWARICH_SUPPORTED_COMMIT,
      }),
      runCollector: async () => {
        started();
        await collectorRelease;
        return Readable.from([Buffer.from("tar")]);
      },
    });
    await app.ready();
    const first = app.inject({
      method: "POST",
      url: "/v1/privacy/dawarich-subject-export",
      headers: { authorization: "Bearer api-token" },
      payload: request,
    });
    await collectorStarted;
    const busy = await app.inject({
      method: "POST",
      url: "/v1/privacy/dawarich-subject-export",
      headers: { authorization: "Bearer api-token" },
      payload: request,
    });
    expect(busy.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/privacy/dawarich-subject-export",
      headers: { authorization: "Bearer api-token" },
      payload: request,
    });
    expect(replay.statusCode).toBe(409);
  });

  it("inspects the pinned image, digest and collector revision without exposing env values", async () => {
    const run = async (_file: string, args: readonly string[]) => {
      expect(args).toEqual([
        "inspect",
        "--type",
        "container",
        "--format",
        "{{json .}}",
        "dawarich-app",
      ]);
      return {
        stdout: JSON.stringify({
          RepoDigests: [`freikin/dawarich@${DAWARICH_SUPPORTED_IMAGE_DIGEST}`],
          Config: {
            Image: DAWARICH_SUPPORTED_IMAGE,
            Env: [`OPENMAPX_DAWARICH_COMMIT=${DAWARICH_SUPPORTED_COMMIT}`],
          },
        }),
        stderr: "",
      };
    };
    await expect(createDockerDawarichRuntimeInspector({ run })()).resolves.toEqual({
      image: DAWARICH_SUPPORTED_IMAGE,
      digest: DAWARICH_SUPPORTED_IMAGE_DIGEST,
      commit: DAWARICH_SUPPORTED_COMMIT,
    });
  });
});
