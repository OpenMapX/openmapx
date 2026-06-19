import { describe, expect, it, vi } from "vitest";
import { createClaudeProvider } from "../providers/claude";
import { createOpenAiProvider } from "../providers/openai";
import type { ParseContext } from "../types";

const CTX: ParseContext = {
  mapCenter: [2.35, 48.86],
  mapBbox: { south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
};

const INTENT = {
  filter: {
    selectors: [{ tags: [{ key: "tourism", op: "=" as const, value: "museum" }] }],
    require: [
      { key: "wheelchair", op: "=" as const, value: "yes" },
      { key: "fee", op: "=" as const, value: "no" },
    ],
  },
  spatial_constraint: { type: "near_place" as const, place_name: "train station" },
  time_constraint: null,
  sort_by: "distance" as const,
  unmapped_attributes: [],
  confidence: 0.9,
  explanation:
    "Museums with wheelchair access, no entry fee, sorted by distance near train station",
};

describe("createClaudeProvider", () => {
  it("has id 'claude' and requiresNetwork true", () => {
    const fakeClient = {
      messages: { create: vi.fn() },
    };
    const provider = createClaudeProvider({
      model: "claude-sonnet-4-5",
      timeoutMs: 10000,
      client: fakeClient,
    });
    expect(provider.id).toBe("claude");
    expect(provider.requiresNetwork).toBe(true);
  });

  it("happy path: calls client.messages.create and returns parsed intent", async () => {
    const createMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(INTENT) }],
    });
    const fakeClient = { messages: { create: createMock } };

    const provider = createClaudeProvider({
      model: "claude-sonnet-4-5",
      timeoutMs: 10000,
      client: fakeClient,
    });

    const result = await provider.parseQuery(
      "museums near train station wheelchair accessible no fee sorted by distance",
      CTX,
    );

    expect(result).toEqual(INTENT);
    expect(createMock).toHaveBeenCalledOnce();

    const args = createMock.mock.calls[0][0];
    expect(args.model).toBe("claude-sonnet-4-5");
    expect(args.max_tokens).toBeGreaterThan(0);
    expect(args.system).toBeDefined();
    expect(Array.isArray(args.messages)).toBe(true);
    expect(args.messages[0].role).toBe("user");
    expect(args.output_config).toBeDefined();
    expect(args.output_config.format.type).toBe("json_schema");
    expect(args.output_config.format.schema).toBeDefined();

    const callOptions = createMock.mock.calls[0][1];
    expect(callOptions).toEqual({ timeout: 10000 });
  });

  it("rejects when no text block is returned", async () => {
    const createMock = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "abc" }],
    });
    const fakeClient = { messages: { create: createMock } };

    const provider = createClaudeProvider({
      model: "claude-sonnet-4-5",
      timeoutMs: 10000,
      client: fakeClient,
    });

    await expect(provider.parseQuery("museums", CTX)).rejects.toThrow();
  });
});

describe("createOpenAiProvider", () => {
  it("has id 'openai' and requiresNetwork true", () => {
    const fakeClient = {
      chat: { completions: { create: vi.fn() } },
    };
    const provider = createOpenAiProvider({
      model: "gpt-4o",
      timeoutMs: 10000,
      client: fakeClient,
    });
    expect(provider.id).toBe("openai");
    expect(provider.requiresNetwork).toBe(true);
  });

  it("happy path: calls client.chat.completions.create and returns parsed intent", async () => {
    const createMock = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(INTENT) } }],
    });
    const fakeClient = { chat: { completions: { create: createMock } } };

    const provider = createOpenAiProvider({
      model: "gpt-4o",
      timeoutMs: 10000,
      client: fakeClient,
    });

    const result = await provider.parseQuery(
      "museums near train station wheelchair accessible no fee sorted by distance",
      CTX,
    );

    expect(result).toEqual(INTENT);
    expect(createMock).toHaveBeenCalledOnce();

    const args = createMock.mock.calls[0][0];
    expect(args.model).toBe("gpt-4o");
    expect(args.temperature).toBe(0);
    expect(Array.isArray(args.messages)).toBe(true);
    expect(args.response_format).toBeDefined();
    expect(args.response_format.type).toBe("json_schema");

    const callOptions = createMock.mock.calls[0][1];
    expect(callOptions).toEqual({ timeout: 10000 });
  });

  it("rejects when content is null", async () => {
    const createMock = vi.fn().mockResolvedValue({
      choices: [{ message: { content: null } }],
    });
    const fakeClient = { chat: { completions: { create: createMock } } };

    const provider = createOpenAiProvider({
      model: "gpt-4o",
      timeoutMs: 10000,
      client: fakeClient,
    });

    await expect(provider.parseQuery("museums", CTX)).rejects.toThrow();
  });
});
