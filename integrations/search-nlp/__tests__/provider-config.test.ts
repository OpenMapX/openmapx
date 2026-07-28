import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_DEFINITIONS,
  isPrivateEndpoint,
  ProviderDefinitionsSchema,
} from "../provider-config";

describe("ProviderDefinitionsSchema", () => {
  it("ships a local-first default chain", () => {
    expect(DEFAULT_PROVIDER_DEFINITIONS.map((provider) => provider.type)).toEqual([
      "ollama",
      "keyword",
    ]);
  });

  it("supports all maintained adapter families", () => {
    const definitions = ProviderDefinitionsSchema.parse([
      { id: "claude", type: "anthropic", model: "claude-haiku-4-5" },
      { id: "openai", type: "openai", model: "gpt-5-mini" },
      { id: "gemini", type: "google", model: "gemini-2.5-flash" },
      { id: "router", type: "openrouter", model: "anthropic/claude-haiku-4.5" },
      {
        id: "groq",
        type: "openai-compatible",
        model: "llama-3.3-70b-versatile",
        baseURL: "https://api.groq.com/openai/v1",
        processor: {
          id: "groq",
          name: "Groq",
          countryCode: "US",
          privacyUrl: "https://groq.com/privacy-policy/",
        },
      },
    ]);

    expect(definitions).toHaveLength(5);
    expect(definitions[1]).toMatchObject({ api: "responses" });
    expect(definitions[3]).toMatchObject({ dataCollection: "deny", zeroDataRetention: true });
  });

  it("rejects duplicate ids", () => {
    const parsed = ProviderDefinitionsSchema.safeParse([
      { id: "same", type: "keyword" },
      { id: "same", type: "ollama", model: "gemma3" },
    ]);
    expect(parsed.success).toBe(false);
  });

  it("requires disclosure metadata for arbitrary cloud endpoints", () => {
    const parsed = ProviderDefinitionsSchema.safeParse([
      {
        id: "custom",
        type: "openai-compatible",
        model: "model",
        baseURL: "https://models.example.com/v1",
      },
    ]);
    expect(parsed.success).toBe(false);
  });

  it("requires TLS for arbitrary cloud endpoints", () => {
    const parsed = ProviderDefinitionsSchema.safeParse([
      {
        id: "custom",
        type: "openai-compatible",
        model: "model",
        baseURL: "http://models.example.com/v1",
        processor: {
          id: "custom",
          name: "Custom Cloud",
          countryCode: "US",
          privacyUrl: "https://models.example.com/privacy",
        },
      },
    ]);
    expect(parsed.success).toBe(false);
  });

  it("never accepts a public endpoint as local", () => {
    expect(isPrivateEndpoint("http://localhost:11434")).toBe(true);
    expect(isPrivateEndpoint("http://local-ai:11434")).toBe(true);
    expect(isPrivateEndpoint("http://ollama.ai.svc:11434")).toBe(true);
    expect(isPrivateEndpoint("http://192.168.1.10:8080/v1")).toBe(true);
    expect(isPrivateEndpoint("https://api.example.com/v1")).toBe(false);
  });
});
