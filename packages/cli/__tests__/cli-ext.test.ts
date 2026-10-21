import type { AdminExtensionInstallPreview } from "@openmapx/core/api-admin-sdk";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExtCommands } from "../src/commands/ext";

const fingerprint = "b".repeat(64);
const rating = {
  score: 4,
  requiresBuiltIn: false,
  hostPorts: 2,
  secretCount: 1,
  deploymentVariables: ["PUBLIC_URL", "CALLBACK_URL"],
  factors: ["host ports", "deployment configuration"],
};
const preview: AdminExtensionInstallPreview = {
  extension: { id: "synthetic", name: "Synthetic bundle", version: "2" },
  sourceTrust: "community",
  services: [
    {
      id: "synthetic-service",
      name: "Synthetic service",
      version: "2",
      repositoryCommit: "a".repeat(40),
      hostPorts: [
        { host: 8080, container: 80, protocol: "tcp", bindAddress: "::" },
        { host: 5353, container: 53, protocol: "udp", bindAddress: "127.0.0.1" },
      ],
      securityRating: rating,
    },
  ],
  requiresHostPortConfirmation: true,
  confirmation: fingerprint,
};
const noPorts: AdminExtensionInstallPreview = {
  ...preview,
  services: [],
  requiresHostPortConfirmation: false,
};
const catalogEntry = {
  id: "synthetic",
  name: "Synthetic bundle",
  trust: "community",
  components: { services: 1, integrations: 2 },
  compatible: true,
  platformVersion: "1",
  installed: true,
  installedVersion: "1",
  hasUpdate: true,
  removed: null,
  critical: null,
  status: "community",
};
const installed = {
  id: "synthetic",
  name: "Synthetic bundle",
  sourceTrust: "community",
  installedVersion: "1",
  sourceUrl: null,
  installedAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
  components: [
    { kind: "service", componentId: "synthetic-service", securityRating: rating },
    { kind: "integration", componentId: "synthetic-ui", enabled: true },
  ],
  hasUpdate: true,
  latestVersion: "2",
};
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let savedExitCode: typeof process.exitCode;

function makeProgram(): Command {
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: (message) => console.error(message) });
  registerExtCommands(program);
  return program;
}
const run = (...args: string[]) => makeProgram().parseAsync(["ext", ...args], { from: "user" });
function request(index = 0): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index];
  if (!call) throw new Error(`Missing request ${index}`);
  return { url: String(call[0]), init: call[1] ?? {} };
}
const stdout = () => vi.mocked(console.log).mock.calls.flat().join("\n");
const stderr = () => vi.mocked(console.error).mock.calls.flat().join("\n");
function respond(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}
function acceptedAfter(inspected: AdminExtensionInstallPreview = noPorts): void {
  fetchMock.mockResolvedValueOnce(respond(inspected));
  fetchMock.mockResolvedValueOnce(respond({ jobId: "job-synthetic-1" }, 202));
}
async function expectFailure(args: string[], calls = 1): Promise<void> {
  await run(...args);
  expect(process.exitCode).toBe(1);
  expect(stderr()).not.toBe("");
  expect(stdout()).not.toMatch(/queued|undefined|job-synthetic-1/);
  expect(`${stdout()}${stderr()}`).not.toContain("SECRET_SENTINEL");
  expect(fetchMock).toHaveBeenCalledTimes(calls);
}

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  vi.stubEnv("API_URL", undefined);
  vi.stubEnv("OPENMAPX_API_URL", undefined);
  vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", undefined);
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(respond({ extensions: [] }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("Unexpected immediate process.exit");
  });
});
afterEach(() => {
  process.exitCode = savedExitCode;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("extension CLI through the final generated SDK", () => {
  it("uses generated query encoding and preserves the catalog table and unknown version", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ entries: [catalogEntry], total: 1, revocationDataStale: false }),
    );
    await run("browse", "-q", "map / %?#雪", "--trust", "community", "--type", "service");
    expect(request().url).toBe(
      "http://localhost:3001/api/admin/extensions/catalog?q=map+%2F+%25%3F%23%E9%9B%AA&trust=community&type=service",
    );
    expect(request().init.method).toBe("GET");
    for (const value of [
      "ID",
      "Name",
      "Version",
      "Trust",
      "Components",
      "State",
      "Synthetic bundle",
      "Version unknown",
      "1s/2i",
      "update",
    ])
      expect(stdout()).toContain(value);
    expect(stdout()).not.toContain("undefined");
  });
  it("preserves browse and installed empty states", async () => {
    fetchMock.mockResolvedValueOnce(respond({ entries: [], total: 0, revocationDataStale: false }));
    await run("browse");
    await run("list");
    expect(stdout()).toContain("(catalog is empty)");
    expect(stdout()).toContain("(no extensions installed)");
    expect(request().url).toBe("http://localhost:3001/api/admin/extensions/catalog");
  });
  it("preserves installed component labels and update arrows", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ extensions: [installed, { ...installed, id: "unknown", latestVersion: null }] }),
    );
    await run("list");
    for (const value of [
      "synthetic",
      "community",
      "s:synthetic-service, i:synthetic-ui",
      "→ 2",
      "→ Version unknown",
    ])
      expect(stdout()).toContain(value);
  });
  it("resolves API_URL then OPENMAPX_API_URL then localhost late per action", async () => {
    const program = makeProgram();
    vi.stubEnv("OPENMAPX_API_URL", "https://fallback.test");
    vi.stubEnv("API_URL", "https://preferred.test/");
    await program.parseAsync(["ext", "list"], { from: "user" });
    vi.stubEnv("API_URL", undefined);
    await run("list");
    vi.stubEnv("OPENMAPX_API_URL", undefined);
    await run("list");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://preferred.test/api/admin/extensions/installed",
      "https://fallback.test/api/admin/extensions/installed",
      "http://localhost:3001/api/admin/extensions/installed",
    ]);
  });
  it("always sends the late trimmed local-admin header and omits credentials without cookies or Origin", async () => {
    const program = makeProgram();
    await run("list");
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "  synthetic-token  \n");
    await program.parseAsync(["ext", "list"], { from: "user" });
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "   ");
    await run("list");
    for (const [index, value] of ["", "synthetic-token", ""].entries()) {
      const { init } = request(index);
      const headers = new Headers(init.headers);
      expect(headers.get("x-openmapx-local-admin")).toBe(value);
      expect(init.credentials).toBe("omit");
      for (const name of ["cookie", "origin", "authorization"])
        expect(headers.has(name)).toBe(false);
    }
    expect(`${stdout()}${stderr()}`).not.toContain("synthetic-token");
  });
  it("prints the complete inspected preview, including IPv6/protocol/commit/security/provenance/fingerprint", async () => {
    fetchMock.mockResolvedValueOnce(respond(preview));
    await run("preview", "synthetic");
    expect(request().url).toBe("http://localhost:3001/api/admin/extensions/install-preview");
    expect(JSON.parse(String(request().init.body))).toEqual({ id: "synthetic" });
    const rendered = vi
      .mocked(console.log)
      .mock.calls.map(([value]) => String(value))
      .find((value) => value.startsWith("{"));
    expect(JSON.parse(rendered ?? "null")).toEqual(preview);
    expect(stdout()).toContain("may fetch");
    expect(stdout()).toContain("--host-port-confirmation");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each(["synthetic", "https://example.test/extension.json?q=a%2Fb#snapshot"])(
    "previews then queues a no-port install with the exact selector: %s",
    async (selector) => {
      acceptedAfter();
      await run("install", selector);
      const body = selector.startsWith("https:") ? { manifestUrl: selector } : { id: selector };
      expect(request().url).toBe("http://localhost:3001/api/admin/extensions/install-preview");
      expect(request(1).url).toBe("http://localhost:3001/api/admin/extensions/install");
      expect(JSON.parse(String(request().init.body))).toEqual(body);
      expect(JSON.parse(String(request(1).init.body))).toEqual(body);
      expect(request(1).init.method).toBe("POST");
      expect(stdout()).toContain(
        "Install queued (job job-synthetic-1). Track it under Admin → Activity.",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["install", "update"])(
    "%s with ports requires an explicit matching fingerprint",
    async (action) => {
      acceptedAfter(preview);
      await run(action, "synthetic", "--host-port-confirmation", fingerprint);
      expect(JSON.parse(String(request().init.body))).toEqual({ id: "synthetic" });
      expect(JSON.parse(String(request(1).init.body))).toEqual(
        action === "install"
          ? { id: "synthetic", hostPortConfirmation: fingerprint }
          : { hostPortConfirmation: fingerprint },
      );
      expect(stdout()).toContain(
        `${action === "install" ? "Install" : "Update"} queued (job job-synthetic-1).`,
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["install", "update"])(
    "%s refuses absent, wrong, and changed-snapshot fingerprints before a write",
    async (action) => {
      for (const supplied of [undefined, "wrong", "c".repeat(64)]) {
        fetchMock.mockReset().mockResolvedValueOnce(respond(preview));
        vi.mocked(console.error).mockClear();
        await expectFailure([
          action,
          "synthetic",
          ...(supplied === undefined ? [] : ["--host-port-confirmation", supplied]),
        ]);
        expect(stderr()).toMatch(/preview/);
        expect(stderr()).toMatch(/inspect|review/i);
        expect(stderr()).not.toContain(fingerprint);
      }
    },
  );
  it("does not offer a --yes host-port bypass", async () => {
    const program = makeProgram();
    await expect(
      program.parseAsync(["ext", "install", "synthetic", "--yes"], { from: "user" }),
    ).rejects.toMatchObject({ code: "commander.unknownOption", exitCode: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("requires new deliberate review when a direct URL's manifest moves after explicit preview", async () => {
    const url = "https://example.test/extension.json";
    fetchMock.mockResolvedValueOnce(respond(preview));
    await run("preview", url);
    vi.mocked(console.log).mockClear();
    fetchMock.mockResolvedValueOnce(
      respond({
        ...preview,
        confirmation: "c".repeat(64),
        services: [{ ...preview.services[0], repositoryCommit: "d".repeat(40) }],
      }),
    );
    await expectFailure(["install", url, "--host-port-confirmation", fingerprint], 2);
  });
  it("does not trust a false confirmation flag when effective bindings still expose ports", async () => {
    fetchMock.mockResolvedValueOnce(respond({ ...preview, requiresHostPortConfirmation: false }));
    await expectFailure(["install", "synthetic"]);
  });
  it("updates the same ID it previews with a bodyless optional body and exactly one path encoding", async () => {
    acceptedAfter();
    await run("update", "space % / ? # 雪");
    expect(JSON.parse(String(request().init.body))).toEqual({ id: "space % / ? # 雪" });
    expect(request(1).url).toBe(
      "http://localhost:3001/api/admin/extensions/update/space%20%25%20%2F%20%3F%20%23%20%E9%9B%AA",
    );
    expect(request(1).init.method).toBe("POST");
    expect(request(1).init.body).toBeUndefined();
    expect(new Headers(request(1).init.headers).has("content-type")).toBe(false);
    expect(stdout()).toContain("Update queued (job job-synthetic-1).");
  });
  it("removes with an absent optional body, single encoded ID, and validated queued ID", async () => {
    fetchMock.mockResolvedValueOnce(respond({ jobId: "job-synthetic-1" }, 202));
    await run("remove", "space % / ? # 雪");
    expect(request().url).toBe(
      "http://localhost:3001/api/admin/extensions/space%20%25%20%2F%20%3F%20%23%20%E9%9B%AA",
    );
    expect(request().init.method).toBe("DELETE");
    expect(request().init.body).toBeUndefined();
    expect(new Headers(request().init.headers).has("content-type")).toBe(false);
    expect(stdout()).toContain("Remove queued (job job-synthetic-1).");
  });
  it("permits a service with no effective ports without inventing confirmation", async () => {
    acceptedAfter({
      ...noPorts,
      services: [
        { ...preview.services[0], hostPorts: [], securityRating: { ...rating, hostPorts: 0 } },
      ],
    });
    await run("install", "synthetic");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request(1).init.body))).toEqual({ id: "synthetic" });
    expect(stdout()).toContain("Install queued (job job-synthetic-1).");
    expect(process.exitCode).toBe(0);
  });
  it("forwards only the explicitly supplied fingerprint for a port-bearing direct URL", async () => {
    acceptedAfter(preview);
    await run(
      "install",
      "https://example.test/extension.json?ref=v2#snapshot",
      "--host-port-confirmation",
      fingerprint,
    );
    expect(JSON.parse(String(request().init.body))).toEqual({
      manifestUrl: "https://example.test/extension.json?ref=v2#snapshot",
    });
    expect(JSON.parse(String(request(1).init.body))).toEqual({
      manifestUrl: "https://example.test/extension.json?ref=v2#snapshot",
      hostPortConfirmation: fingerprint,
    });
    expect(process.exitCode).toBe(0);
  });
  it("refuses stale supplied confirmation even if the new snapshot has no ports", async () => {
    fetchMock.mockResolvedValueOnce(respond(noPorts));
    await expectFailure(["update", "synthetic", "--host-port-confirmation", "c".repeat(64)]);
  });
  it.each(["browse", "list", "preview", "install", "update", "remove"])(
    "%s sends local-admin auth without browser credentials on every request",
    async (action) => {
      vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "  synthetic-token  ");
      if (action === "browse")
        fetchMock.mockResolvedValueOnce(
          respond({ entries: [], total: 0, revocationDataStale: false }),
        );
      else if (action === "preview") fetchMock.mockResolvedValueOnce(respond(preview));
      else if (["install", "update"].includes(action)) acceptedAfter();
      else if (action === "remove")
        fetchMock.mockResolvedValueOnce(respond({ jobId: "job-synthetic-1" }, 202));
      await run(action, ...(["browse", "list"].includes(action) ? [] : ["synthetic"]));
      expect(process.exitCode).toBe(0);
      for (const [, init] of fetchMock.mock.calls) {
        const headers = new Headers(init?.headers);
        expect(init?.credentials).toBe("omit");
        expect(headers.get("x-openmapx-local-admin")).toBe("synthetic-token");
        for (const name of ["cookie", "origin", "authorization"])
          expect(headers.has(name)).toBe(false);
      }
      expect(`${stdout()}${stderr()}`).not.toContain("synthetic-token");
    },
  );
  it("retains the invocation client and selector across preview while another action changes environment", async () => {
    vi.stubEnv("API_URL", "https://first.test");
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "  first-token  ");
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const install = run("install", "synthetic");
    vi.stubEnv("API_URL", "https://second.test");
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "  second-token  ");
    await run("list");
    fetchMock.mockResolvedValueOnce(respond({ jobId: "job-synthetic-1" }, 202));
    release(respond(noPorts));
    await install;
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://first.test/api/admin/extensions/install-preview",
      "https://second.test/api/admin/extensions/installed",
      "https://first.test/api/admin/extensions/install",
    ]);
    expect(JSON.parse(String(request(2).init.body))).toEqual({ id: "synthetic" });
    expect(new Headers(request().init.headers).get("x-openmapx-local-admin")).toBe("first-token");
    expect(new Headers(request(2).init.headers).get("x-openmapx-local-admin")).toBe("second-token");
  });
});

describe("safe finite CLI failures without retry", () => {
  it.each([400, 401, 403, 404, 413, 415, 500])(
    "declared preview HTTP %s is safe and cannot enqueue",
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        respond({ error: "SECRET_SENTINEL https://private.test/token" }, status),
      );
      await expectFailure(["install", "synthetic"]);
      expect(stderr()).toContain(`HTTP ${status}`);
    },
  );
  it.each(["browse", "list", "preview", "install", "update", "remove"])(
    "all %s failures exit nonzero on safe stderr",
    async (action) => {
      fetchMock.mockResolvedValueOnce(respond({ error: "SECRET_SENTINEL" }, 403));
      await expectFailure([action, ...(["browse", "list"].includes(action) ? [] : ["synthetic"])]);
    },
  );
  it.each(["install", "update"])(
    "%s write rejection is reported once after successful preview",
    async (action) => {
      fetchMock
        .mockResolvedValueOnce(respond(noPorts))
        .mockResolvedValueOnce(respond({ error: "SECRET_SENTINEL critical advisory" }, 400));
      await expectFailure([action, "synthetic"], 2);
      expect(stderr()).toContain("HTTP 400");
    },
  );
  it.each(["preview", "install", "update", "remove"])(
    "%s reports declared 429 Retry-After safely and never retries",
    async (action) => {
      if (["install", "update"].includes(action)) fetchMock.mockResolvedValueOnce(respond(noPorts));
      fetchMock.mockResolvedValueOnce(
        respond({ error: "SECRET_SENTINEL", retryAfter: 30 }, 429, { "Retry-After": "30" }),
      );
      await expectFailure([action, "synthetic"], ["install", "update"].includes(action) ? 2 : 1);
      expect(stderr()).toContain("429");
      expect(stderr()).toContain("30");
      expect(stderr()).toMatch(/Retry-After/);
    },
  );
  it.each([
    [
      "wrong media",
      () => new Response("SECRET_SENTINEL", { headers: { "content-type": "text/html" } }),
    ],
    [
      "malformed JSON",
      () =>
        new Response('{"SECRET_SENTINEL":', { headers: { "content-type": "application/json" } }),
    ],
    ["incomplete success", () => respond({ extensions: [{}], secret: "SECRET_SENTINEL" })],
    ["undeclared success", () => respond({ extensions: [], secret: "SECRET_SENTINEL" }, 201)],
    [
      "oversized success",
      () => respond({ extensions: [], secret: `SECRET_SENTINEL${"x".repeat(8 * 1024 * 1024)}` }),
    ],
    ["oversized error", () => respond({ error: `SECRET_SENTINEL${"x".repeat(64 * 1024)}` }, 400)],
    ["wrong error media", () => new Response("SECRET_SENTINEL", { status: 500 })],
    ["undeclared error", () => respond({ error: "SECRET_SENTINEL" }, 502)],
  ] as const)("rejects %s via the real transport", async (_name, response) => {
    fetchMock.mockResolvedValueOnce(response());
    await expectFailure(["list"]);
  });
  it.each([
    [200, { jobId: "job-synthetic-1" }],
    [202, {}],
    [202, { jobId: "" }],
    [202, { jobId: "job-synthetic-1", secret: "SECRET_SENTINEL" }],
  ])("rejects invalid queued acceptance %s %j", async (status, data) => {
    fetchMock.mockResolvedValueOnce(respond(data, status));
    await expectFailure(["remove", "synthetic"]);
  });
  it.each(["install", "update"])(
    "%s never reports malformed acceptance as a queued job",
    async (action) => {
      fetchMock
        .mockResolvedValueOnce(respond(noPorts))
        .mockResolvedValueOnce(respond({ jobId: "job-synthetic-1" }, 200));
      await expectFailure([action, "synthetic"], 2);
    },
  );
  it("rejects incomplete preview disclosure before any install write", async () => {
    const { deploymentVariables: _missing, ...incompleteRating } = rating;
    fetchMock.mockResolvedValueOnce(
      respond({
        ...preview,
        services: [{ ...preview.services[0], securityRating: incompleteRating }],
      }),
    );
    await expectFailure(["install", "synthetic", "--host-port-confirmation", fingerprint]);
  });
  it("stops at preview 429 after explicit inspection without retrying or spending a write", async () => {
    fetchMock.mockResolvedValueOnce(respond(preview));
    await run("preview", "synthetic");
    vi.mocked(console.log).mockClear();
    fetchMock.mockResolvedValueOnce(
      respond({ error: "SECRET_SENTINEL", retryAfter: 30 }, 429, { "Retry-After": "30" }),
    );
    await expectFailure(["install", "synthetic", "--host-port-confirmation", fingerprint], 2);
    expect(request(1).url).toBe("http://localhost:3001/api/admin/extensions/install-preview");
    expect(stderr()).toContain("Retry-After (30s)");
  });
  it("does not reflect a malformed Retry-After header", async () => {
    fetchMock.mockResolvedValueOnce(
      respond({ error: "SECRET_SENTINEL", retryAfter: 30 }, 429, {
        "Retry-After": "SECRET_SENTINEL",
      }),
    );
    await expectFailure(["remove", "synthetic"]);
  });
  it("does not expose fetch exceptions or token values", async () => {
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "SECRET_SENTINEL");
    fetchMock.mockRejectedValueOnce(new Error("SECRET_SENTINEL private path"));
    await expectFailure(["remove", "synthetic"]);
  });
  it("bounds a stalled error body without printing the response payload", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"error":"SECRET_SENTINEL'));
          },
          cancel,
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    let settled = false;
    const pending = run("list").then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await pending;
    expect(process.exitCode).toBe(1);
    expect(stderr()).toMatch(/without a confirmed result/);
    expect(stderr()).not.toContain("SECRET_SENTINEL");
    expect(stdout()).toBe("");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["browse", 30_000, false],
    ["list", 30_000, false],
    ["preview", 180_000, false],
    ["install", 180_000, false],
    ["install", 180_000, true],
    ["update", 180_000, true],
    ["remove", 180_000, false],
  ] as const)(
    "%s uses the finite %sms deadline through stalled response bodies (write=%s)",
    async (action, deadline, write) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      if (write) fetchMock.mockResolvedValueOnce(respond(noPorts));
      fetchMock.mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"SECRET_SENTINEL":'));
            },
            cancel,
          }),
          {
            status: write || action === "remove" ? 202 : 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
      let settled = false;
      let rejected: unknown;
      const pending = run(
        action,
        ...(["browse", "list"].includes(action) ? [] : ["synthetic"]),
      ).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          rejected = error;
          settled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await pending;
      expect(rejected).toBeUndefined();
      expect(process.exitCode).toBe(1);
      expect(stderr()).toMatch(/without a confirmed result/);
      expect(stderr()).toMatch(/Activity/);
      expect(stderr()).not.toContain("SECRET_SENTINEL");
      expect(stdout()).not.toMatch(/queued|undefined/);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(write ? 2 : 1);
      expect(request(write ? 1 : 0).init.signal?.aborted).toBe(true);
    },
  );
});
