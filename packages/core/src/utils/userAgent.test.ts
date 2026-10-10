import { afterEach, describe, expect, it, vi } from "vitest";

async function load() {
  vi.resetModules();
  return import("./userAgent");
}

describe("userAgent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the scanner name nmap out of every fixed user-agent", async () => {
    const ua = await load();
    for (const value of [ua.USER_AGENT, ua.USER_AGENT_ADMIN, ua.userAgent("").split("(")[0]]) {
      expect(value.toLowerCase()).not.toContain("nmap");
    }
  });

  it("identifies as Open-MapX", async () => {
    const ua = await load();
    expect(ua.USER_AGENT).toBe("Open-MapX/1.0");
    expect(ua.USER_AGENT_ADMIN).toBe("Open-MapX-Admin/1.0");
    expect(ua.userAgent("x@example.com")).toBe("Open-MapX/1.0 (x@example.com)");
  });

  it("keeps the configured contact domain in the contact forms", async () => {
    vi.stubEnv("DOMAIN", "maps.example.net");
    const ua = await load();
    expect(ua.USER_AGENT_TRANSIT).toBe("Open-MapX/1.0 (transit@maps.example.net)");
    expect(ua.USER_AGENT_CONTACT).toBe("Open-MapX/1.0 (+https://maps.example.net)");
  });
});
