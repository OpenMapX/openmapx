import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminFetch } from "../src/lib/admin-fetch";

let fetchMock: ReturnType<typeof vi.fn>;

function lastInit(): RequestInit {
  const call = fetchMock.mock.calls.at(-1);
  return (call?.[1] ?? {}) as RequestInit;
}

function headerValue(): string | null {
  return new Headers(lastInit().headers).get("x-openmapx-local-admin");
}

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("adminFetch", () => {
  it("sends the trimmed token when configured", async () => {
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "  test-local-admin-token-fake  ");
    await adminFetch("http://localhost:3001/api/admin/x");
    expect(headerValue()).toBe("test-local-admin-token-fake");
  });

  it("sends an empty header when the token is unset (CSRF-defeating)", async () => {
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "");
    await adminFetch("http://localhost:3001/api/admin/x");
    expect(headerValue()).toBe("");
  });

  it("lets a caller-supplied header win", async () => {
    vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "test-local-admin-token-fake");
    await adminFetch("http://localhost:3001/api/admin/x", {
      headers: { "x-openmapx-local-admin": "caller-fake" },
    });
    expect(headerValue()).toBe("caller-fake");
  });

  it("forwards method and body unchanged", async () => {
    await adminFetch("http://localhost:3001/api/admin/x", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    const init = lastInit();
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });
});
