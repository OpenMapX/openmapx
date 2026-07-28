import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSecretFields, validateConfigBody } from "../validate-config-body";

const schema = {
  properties: {
    apiKey: {
      type: "string",
      title: "API Key",
      description: "Provider API key",
      "x-openmapx-secret": true,
      "x-openmapx-sharedSecretName": "PROVIDER_KEY",
    },
    sharedToken: {
      type: "string",
      "x-openmapx-secret": true,
    },
    baseUrl: { type: "string" },
    timeoutMs: { type: "integer" },
    ratio: { type: "number" },
    debug: { type: "boolean" },
    mode: { type: "string", enum: ["fast", "slow"] },
    endpoint: { type: "string", format: "url" },
    enabled: { type: "boolean" },
  },
};

const searchNlpManifest = JSON.parse(
  readFileSync(
    new URL("../../../../../integrations/search-nlp/manifest.json", import.meta.url),
    "utf8",
  ),
) as { configSchema: Record<string, unknown> };

describe("getSecretFields", () => {
  it("extracts only fields marked x-openmapx-secret", () => {
    const fields = getSecretFields(schema);
    expect(fields.map((f) => f.key).sort()).toEqual(["apiKey", "sharedToken"]);
  });

  it("uses the field title and description when present", () => {
    const fields = getSecretFields(schema);
    const apiKey = fields.find((f) => f.key === "apiKey");
    expect(apiKey).toEqual({
      key: "apiKey",
      title: "API Key",
      description: "Provider API key",
      sharedSecretName: "PROVIDER_KEY",
    });
  });

  it("falls back to the key as title when no title is set", () => {
    const fields = getSecretFields(schema);
    const shared = fields.find((f) => f.key === "sharedToken");
    expect(shared).toEqual({
      key: "sharedToken",
      title: "sharedToken",
      description: undefined,
      sharedSecretName: undefined,
    });
  });

  it("returns an empty array when configSchema is undefined", () => {
    expect(getSecretFields(undefined)).toEqual([]);
  });

  it("returns an empty array when there are no secret fields", () => {
    expect(getSecretFields({ properties: { plain: { type: "string" } } })).toEqual([]);
  });

  it("reads properties directly when the schema is not wrapped under properties", () => {
    const fields = getSecretFields({ token: { type: "string", "x-openmapx-secret": true } });
    expect(fields.map((f) => f.key)).toEqual(["token"]);
  });

  it("extracts the x-openmapx-setup guidance block", () => {
    const fields = getSecretFields({
      properties: {
        token: {
          type: "string",
          "x-openmapx-secret": true,
          "x-openmapx-setup": {
            url: "https://provider.example/keys",
            steps: ["Sign up", "Copy key"],
            cost: "Free tier",
            email: { to: "api@provider.example", subject: "Access" },
          },
        },
      },
    });
    expect(fields[0]?.setup).toEqual({
      url: "https://provider.example/keys",
      steps: ["Sign up", "Copy key"],
      cost: "Free tier",
      email: { to: "api@provider.example", subject: "Access" },
    });
  });

  it("ignores a malformed x-openmapx-setup block", () => {
    const fields = getSecretFields({
      properties: {
        token: {
          type: "string",
          "x-openmapx-secret": true,
          "x-openmapx-setup": { steps: "not-an-array" },
        },
      },
    });
    expect(fields[0]?.setup).toBeUndefined();
  });

  it("skips reserved keys and non-object definitions", () => {
    const fields = getSecretFields({
      properties: {
        type: { "x-openmapx-secret": true },
        properties: { "x-openmapx-secret": true },
        bogus: null,
        real: { "x-openmapx-secret": true },
      },
    } as Record<string, unknown>);
    expect(fields.map((f) => f.key)).toEqual(["real"]);
  });
});

describe("validateConfigBody body shape rejection", () => {
  it("rejects a null body", () => {
    const result = validateConfigBody(null, schema);
    expect(result.errors).toEqual(["Body must be a JSON object"]);
    expect(result.updates).toEqual({});
  });

  it("rejects a non-object body", () => {
    expect(validateConfigBody("nope", schema).errors).toEqual(["Body must be a JSON object"]);
    expect(validateConfigBody(42, schema).errors).toEqual(["Body must be a JSON object"]);
  });

  it("rejects an array body", () => {
    const result = validateConfigBody([{ baseUrl: "x" }], schema);
    expect(result.errors).toEqual(["Body must be a JSON object"]);
  });

  it("accepts an empty object with no updates and no errors", () => {
    const result = validateConfigBody({}, schema);
    expect(result).toEqual({ updates: {}, errors: [] });
  });
});

describe("validateConfigBody valid values", () => {
  it("accepts well-typed values across all supported types", () => {
    const result = validateConfigBody(
      {
        baseUrl: "https://example.com",
        timeoutMs: 5000,
        ratio: 0.5,
        debug: true,
        mode: "fast",
      },
      schema,
    );
    expect(result.errors).toEqual([]);
    expect(result.updates).toEqual({
      baseUrl: "https://example.com",
      timeoutMs: 5000,
      ratio: 0.5,
      debug: true,
      mode: "fast",
    });
  });

  it("ignores the reserved type and properties keys without erroring", () => {
    const result = validateConfigBody(
      { type: "object", properties: {}, baseUrl: "https://x.test" },
      schema,
    );
    expect(result.errors).toEqual([]);
    expect(result.updates).toEqual({ baseUrl: "https://x.test" });
  });
});

describe("validateConfigBody nested schemas", () => {
  const nestedSchema = {
    properties: {
      providers: {
        type: "array",
        minItems: 1,
        items: {
          oneOf: [
            {
              type: "object",
              required: ["id", "type"],
              additionalProperties: false,
              properties: {
                id: { type: "string", pattern: "^[a-z]+$" },
                type: { const: "keyword" },
              },
            },
            {
              type: "object",
              required: ["id", "type", "baseURL"],
              additionalProperties: false,
              properties: {
                id: { type: "string", pattern: "^[a-z]+$" },
                type: { const: "compatible" },
                baseURL: { type: "string", format: "url" },
              },
            },
          ],
        },
      },
    },
  };

  it("accepts arrays of discriminated objects", () => {
    const providers = [
      { id: "remote", type: "compatible", baseURL: "https://models.example/v1" },
      { id: "keyword", type: "keyword" },
    ];
    expect(validateConfigBody({ providers }, nestedSchema)).toEqual({
      updates: { providers },
      errors: [],
    });
  });

  it("rejects invalid variants, nested URLs, and extra properties", () => {
    expect(
      validateConfigBody(
        { providers: [{ id: "remote", type: "compatible", baseURL: "file:///tmp/x" }] },
        nestedSchema,
      ).errors,
    ).toEqual(['"providers"[0] does not match an allowed shape for type "compatible"']);
    expect(
      validateConfigBody(
        { providers: [{ id: "keyword", type: "keyword", secret: "nope" }] },
        nestedSchema,
      ).errors,
    ).toEqual(['"providers"[0] does not match an allowed shape for type "keyword"']);
  });

  it("enforces collection bounds", () => {
    expect(validateConfigBody({ providers: [] }, nestedSchema).errors).toEqual([
      '"providers" must contain at least 1 item(s)',
    ]);
  });

  it("supports conditional requirements", () => {
    const conditionalSchema = JSON.parse(`{
      "properties": {
        "provider": {
          "type": "object",
          "properties": {
            "local": { "type": "boolean" },
            "processor": { "type": "string" }
          },
          "allOf": [{
            "if": { "type": "object", "properties": { "local": { "const": false } } },
            "then": { "type": "object", "required": ["processor"] }
          }]
        }
      }
    }`) as Record<string, unknown>;

    expect(validateConfigBody({ provider: { local: false } }, conditionalSchema).errors).toEqual([
      '"provider".processor is required',
    ]);
    expect(validateConfigBody({ provider: { local: true } }, conditionalSchema).errors).toEqual([]);
  });
});

describe("search-nlp manifest provider schema", () => {
  const processor = {
    id: "groq",
    name: "Groq",
    countryCode: "US",
    privacyUrl: "https://groq.com/privacy-policy/",
  };

  it("accepts maintained, local, and custom cloud provider definitions", () => {
    const providers = [
      { id: "gemini", type: "google", model: "gemini-2.5-flash" },
      { id: "router", type: "openrouter", model: "openai/gpt-4.1-mini" },
      {
        id: "local-compatible",
        type: "openai-compatible",
        model: "local-model",
        baseURL: "http://local-ai:8000/v1",
        credential: "none",
        local: true,
      },
      {
        id: "groq",
        type: "openai-compatible",
        model: "llama-3.3-70b-versatile",
        baseURL: "https://api.groq.com/openai/v1",
        processor,
      },
    ];

    expect(validateConfigBody({ providers }, searchNlpManifest.configSchema)).toEqual({
      updates: { providers },
      errors: [],
    });
  });

  it("rejects undisclosed or plaintext custom cloud providers", () => {
    const withoutDisclosure = validateConfigBody(
      {
        providers: [
          {
            id: "custom",
            type: "openai-compatible",
            model: "model",
            baseURL: "https://models.example.com/v1",
          },
        ],
      },
      searchNlpManifest.configSchema,
    );
    expect(withoutDisclosure.errors).toHaveLength(1);

    const plaintext = validateConfigBody(
      {
        providers: [
          {
            id: "custom",
            type: "openai-compatible",
            model: "model",
            baseURL: "http://models.example.com/v1",
            processor: { ...processor, id: "custom" },
          },
        ],
      },
      searchNlpManifest.configSchema,
    );
    expect(plaintext.errors).toHaveLength(1);
  });
});

describe("validateConfigBody unknown and type errors", () => {
  it("rejects an unknown config key", () => {
    const result = validateConfigBody({ nope: 1 }, schema);
    expect(result.errors).toEqual(['Unknown config key: "nope"']);
    expect(result.updates).toEqual({});
  });

  it("rejects a non-boolean for a boolean field", () => {
    expect(validateConfigBody({ debug: "true" }, schema).errors).toEqual([
      '"debug" must be a boolean',
    ]);
  });

  it("rejects a non-number for number and integer fields", () => {
    expect(validateConfigBody({ ratio: "1.5" }, schema).errors).toEqual([
      '"ratio" must be a number',
    ]);
    expect(validateConfigBody({ timeoutMs: "5000" }, schema).errors).toEqual([
      '"timeoutMs" must be a number',
    ]);
  });

  it("rejects a non-string for a string field", () => {
    expect(validateConfigBody({ baseUrl: 123 }, schema).errors).toEqual([
      '"baseUrl" must be a string',
    ]);
  });

  it("rejects a value outside an enum", () => {
    expect(validateConfigBody({ mode: "turbo" }, schema).errors).toEqual([
      '"mode" must be one of: fast, slow',
    ]);
  });

  it("collects multiple errors and keeps the valid update", () => {
    const result = validateConfigBody({ debug: "x", baseUrl: "ok", nope: 1 }, schema);
    expect(result.errors).toEqual(['"debug" must be a boolean', 'Unknown config key: "nope"']);
    expect(result.updates).toEqual({ baseUrl: "ok" });
  });
});

describe("validateConfigBody secret handling", () => {
  it("rejects secret fields by default", () => {
    const result = validateConfigBody({ apiKey: "leaked" }, schema);
    expect(result.errors).toEqual(['"apiKey" is a secret field — use the credentials API instead']);
    expect(result.updates).toEqual({});
  });

  it("allows secret fields through when rejectSecrets is false", () => {
    const result = validateConfigBody({ apiKey: "value" }, schema, { rejectSecrets: false });
    expect(result.errors).toEqual([]);
    expect(result.updates).toEqual({ apiKey: "value" });
  });
});

describe("validateConfigBody enabled handling", () => {
  it("rejects the enabled key by default", () => {
    const result = validateConfigBody({ enabled: true }, schema);
    expect(result.errors).toEqual(['"enabled" must be set via the enable/disable endpoints']);
    expect(result.updates).toEqual({});
  });

  it("allows the enabled key when rejectEnabled is false", () => {
    const result = validateConfigBody({ enabled: false }, schema, { rejectEnabled: false });
    expect(result.errors).toEqual([]);
    expect(result.updates).toEqual({ enabled: false });
  });
});

describe("validateConfigBody url-format fields", () => {
  it("accepts an internal http(s) endpoint", () => {
    const result = validateConfigBody({ endpoint: "https://osrm:5000" }, schema);
    expect(result.errors).toEqual([]);
    expect(result.updates.endpoint).toBe("https://osrm:5000");
  });

  it("accepts http://localhost so self-hosted internal URLs pass", () => {
    const result = validateConfigBody({ endpoint: "http://localhost:8081" }, schema);
    expect(result.errors).toEqual([]);
    expect(result.updates.endpoint).toBe("http://localhost:8081");
  });

  it("rejects a file:// url", () => {
    const result = validateConfigBody({ endpoint: "file:///etc/passwd" }, schema);
    expect(result.errors).toEqual(['"endpoint" must be a valid http(s) URL']);
    expect(result.updates).not.toHaveProperty("endpoint");
  });

  it("rejects a non-URL string", () => {
    const result = validateConfigBody({ endpoint: "not a url" }, schema);
    expect(result.errors).toEqual(['"endpoint" must be a valid http(s) URL']);
    expect(result.updates).not.toHaveProperty("endpoint");
  });

  it("accepts an empty string as unset", () => {
    const result = validateConfigBody({ endpoint: "" }, schema);
    expect(result.errors).toEqual([]);
    expect(result.updates.endpoint).toBe("");
  });

  it("leaves plain string fields unaffected by the url check", () => {
    const result = validateConfigBody({ baseUrl: "not a url" }, schema);
    expect(result.errors).toEqual([]);
    expect(result.updates).toEqual({ baseUrl: "not a url" });
  });
});

describe("validateConfigBody schema variations", () => {
  it("treats every key as unknown when configSchema is undefined", () => {
    const result = validateConfigBody({ anything: 1 }, undefined);
    expect(result.errors).toEqual(['Unknown config key: "anything"']);
  });

  it("reads properties directly when the schema is not wrapped under properties", () => {
    const result = validateConfigBody({ host: "h" }, { host: { type: "string" } });
    expect(result.errors).toEqual([]);
    expect(result.updates).toEqual({ host: "h" });
  });

  it("accepts any value type when the field def has no type", () => {
    const result = validateConfigBody({ freeform: { nested: true } }, { freeform: {} });
    expect(result.errors).toEqual([]);
    expect(result.updates).toEqual({ freeform: { nested: true } });
  });
});
