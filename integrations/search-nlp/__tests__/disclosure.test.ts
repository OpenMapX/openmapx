import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { computeAiSearchDisclosure } from "../index";

function makeCtx(config: Record<string, unknown>): IntegrationContext {
  return {
    id: "search-nlp",
    config,
    cache: {
      async get() {
        return null;
      },
      async set() {},
      async del() {},
      async withCache<T>(_key: string, _ttl: number, fn: () => Promise<T>) {
        return fn();
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getRequiredService: () => null,
    getIntegrationsByDomain: () => [],
    registerRoute: vi.fn(),
    registerHealthCheck: vi.fn(),
    registerDisclosure: vi.fn(),
  } as unknown as IntegrationContext;
}

describe("computeAiSearchDisclosure", () => {
  it("chain [keyword] → aiActive false, nothing active", () => {
    const ctx = makeCtx({ providerChain: ["keyword"] });
    const d = computeAiSearchDisclosure(ctx);
    expect(d.type).toBe("ai-search");
    expect(d.integrationId).toBe("search-nlp");
    expect(d.aiActive).toBe(false);
    expect(d.localActive).toBe(false);
    expect(d.cloudActive).toBe(false);
    expect(d.cloudVendors).toEqual([]);
  });

  it("default chain [local, keyword] → aiActive true, localActive true, no cloud", () => {
    const ctx = makeCtx({ providerChain: ["local", "keyword"] });
    const d = computeAiSearchDisclosure(ctx);
    expect(d.aiActive).toBe(true);
    expect(d.localActive).toBe(true);
    expect(d.cloudActive).toBe(false);
    expect(d.cloudVendors).toEqual([]);
  });

  it("chain [local, claude, keyword] + anthropicApiKey → cloudActive true, cloudVendors [anthropic]", () => {
    const ctx = makeCtx({
      providerChain: ["local", "claude", "keyword"],
      anthropicApiKey: "sk-x",
    });
    const d = computeAiSearchDisclosure(ctx);
    expect(d.cloudActive).toBe(true);
    expect(d.cloudVendors).toEqual(["anthropic"]);
    expect(d.aiActive).toBe(true);
    expect(d.localActive).toBe(true);
  });

  it("chain [claude] with no key → cloudActive false, cloudVendors [], aiActive false", () => {
    const ctx = makeCtx({ providerChain: ["claude"] });
    const d = computeAiSearchDisclosure(ctx);
    expect(d.cloudActive).toBe(false);
    expect(d.cloudVendors).toEqual([]);
    expect(d.aiActive).toBe(false);
  });

  it("chain [local, openai] + openaiApiKey → cloudVendors [openai], cloudActive true", () => {
    const ctx = makeCtx({
      providerChain: ["local", "openai"],
      openaiApiKey: "sk-y",
    });
    const d = computeAiSearchDisclosure(ctx);
    expect(d.cloudVendors).toEqual(["openai"]);
    expect(d.cloudActive).toBe(true);
    expect(d.aiActive).toBe(true);
    expect(d.localActive).toBe(true);
  });
});
