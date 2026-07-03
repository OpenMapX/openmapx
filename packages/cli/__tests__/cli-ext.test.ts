import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExtCommands } from "../src/commands/ext";

let fetchMock: ReturnType<typeof vi.fn>;

function makeProgram(): Command {
  const program = new Command();
  registerExtCommands(program);
  return program;
}

function firstCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls[0];
  return [String(call[0]), (call[1] ?? {}) as RequestInit];
}

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ jobId: "job-1", entries: [], extensions: [] }),
    text: async () => "",
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ext command HTTP transport", () => {
  it("browse issues a GET with query params", async () => {
    await makeProgram().parseAsync(["ext", "browse", "-q", "map", "--trust", "verified"], {
      from: "user",
    });
    const [url, init] = firstCall();
    expect(init.method).toBeUndefined();
    expect(url).toBe("http://localhost:3001/api/admin/extensions/catalog?q=map&trust=verified");
  });

  it("list issues a GET to installed", async () => {
    await makeProgram().parseAsync(["ext", "list"], { from: "user" });
    const [url] = firstCall();
    expect(url.endsWith("/api/admin/extensions/installed")).toBe(true);
  });

  it("install by id POSTs a { id } body", async () => {
    await makeProgram().parseAsync(["ext", "install", "openconditions"], { from: "user" });
    const [url, init] = firstCall();
    expect(init.method).toBe("POST");
    expect(url.endsWith("/api/admin/extensions/install")).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ id: "openconditions" });
  });

  it("install by URL POSTs a { manifestUrl } body", async () => {
    await makeProgram().parseAsync(["ext", "install", "https://example.test/extension.json"], {
      from: "user",
    });
    const [, init] = firstCall();
    expect(JSON.parse(String(init.body))).toEqual({
      manifestUrl: "https://example.test/extension.json",
    });
  });

  it("update POSTs to the update endpoint", async () => {
    await makeProgram().parseAsync(["ext", "update", "openconditions"], { from: "user" });
    const [url, init] = firstCall();
    expect(init.method).toBe("POST");
    expect(url.endsWith("/api/admin/extensions/update/openconditions")).toBe(true);
  });

  it("remove issues a DELETE", async () => {
    await makeProgram().parseAsync(["ext", "remove", "openconditions"], { from: "user" });
    const [url, init] = firstCall();
    expect(init.method).toBe("DELETE");
    expect(url.endsWith("/api/admin/extensions/openconditions")).toBe(true);
  });

  it("attaches the local admin header (empty when unset)", async () => {
    await makeProgram().parseAsync(["ext", "list"], { from: "user" });
    const [, init] = firstCall();
    const value = new Headers(init.headers).get("x-openmapx-local-admin");
    expect(typeof value).toBe("string");
    expect(value).toBe("");
  });

  it("sends the configured local admin token", async () => {
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "test-local-admin-token-fake");
    await makeProgram().parseAsync(["ext", "list"], { from: "user" });
    const [, init] = firstCall();
    expect(new Headers(init.headers).get("x-openmapx-local-admin")).toBe(
      "test-local-admin-token-fake",
    );
  });

  it("exits non-zero when the API returns a non-2xx status", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Admin access required" }),
      text: async () => "denied",
    } as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    await expect(
      makeProgram().parseAsync(["ext", "install", "x"], { from: "user" }),
    ).rejects.toThrow("exit:1");
  });
});
