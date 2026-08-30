import { isPrivateEndpoint } from "./provider-config.js";
import {
  EMBEDDING_SCHEMA_VERSION,
  type EmbeddingModelIdentity,
  SEMANTIC_DIMENSIONS,
  SEMANTIC_MODEL,
  SemanticEmbeddingError,
} from "./semantic-taxonomy-types.js";

export interface LocalEmbeddingClient {
  inspect(signal: AbortSignal): Promise<EmbeddingModelIdentity>;
  embed(inputs: readonly string[], signal: AbortSignal): Promise<readonly Float32Array[]>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function boundedJson(response: Response, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new SemanticEmbeddingError("invalid-response", "Ollama response exceeded size limit");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SemanticEmbeddingError("invalid-response", "Ollama returned invalid JSON");
  }
}

function validateVector(value: unknown): Float32Array {
  if (!Array.isArray(value) || value.length !== SEMANTIC_DIMENSIONS) {
    throw new SemanticEmbeddingError("invalid-response", "Ollama returned invalid dimensions");
  }
  let normSquared = 0;
  const numbers = new Array<number>(SEMANTIC_DIMENSIONS);
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new SemanticEmbeddingError("invalid-response", "Ollama returned non-finite values");
    }
    numbers[index] = item;
    normSquared += item * item;
  }
  const norm = Math.sqrt(normSquared);
  if (norm === 0 || Math.abs(norm - 1) > 0.01) {
    throw new SemanticEmbeddingError("invalid-response", "Ollama returned a non-unit vector");
  }
  return Float32Array.from(numbers);
}

export function createOllamaEmbeddingClient(options: {
  endpoint: string;
  fetchImpl?: typeof fetch;
}): LocalEmbeddingClient {
  if (!isPrivateEndpoint(options.endpoint)) {
    throw new SemanticEmbeddingError("service-absent", "Semantic endpoint must be private");
  }
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async inspect(signal) {
      let response: Response;
      try {
        response = await fetchImpl(`${endpoint}/api/tags`, { signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SemanticEmbeddingError("service-absent", "Ollama tags request failed");
      }
      if (!response.ok) {
        throw new SemanticEmbeddingError("service-absent", `Ollama tags HTTP ${response.status}`);
      }
      const root = record(await boundedJson(response));
      const models = root?.models;
      if (!Array.isArray(models)) {
        throw new SemanticEmbeddingError("invalid-response", "Ollama tags response is malformed");
      }
      const model = models.map(record).find((item) => item?.name === SEMANTIC_MODEL);
      const digest = model?.digest;
      if (!model) {
        throw new SemanticEmbeddingError("model-not-ready", "Pinned semantic model is absent");
      }
      if (typeof digest !== "string" || digest.length === 0) {
        throw new SemanticEmbeddingError("invalid-response", "Pinned model digest is missing");
      }
      return {
        provider: "ollama",
        model: SEMANTIC_MODEL,
        digest,
        dimensions: SEMANTIC_DIMENSIONS,
        embeddingSchemaVersion: EMBEDDING_SCHEMA_VERSION,
      };
    },

    async embed(inputs, signal) {
      if (inputs.length === 0 || inputs.length > 128 || inputs.some((input) => !input)) {
        throw new SemanticEmbeddingError("invalid-response", "Embedding input batch is invalid");
      }
      let response: Response;
      try {
        response = await fetchImpl(`${endpoint}/api/embed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: SEMANTIC_MODEL,
            input: inputs,
            dimensions: SEMANTIC_DIMENSIONS,
            truncate: false,
            keep_alive: "30m",
          }),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SemanticEmbeddingError("service-absent", "Ollama embed request failed");
      }
      if (!response.ok) {
        throw new SemanticEmbeddingError(
          "invalid-response",
          `Ollama embed HTTP ${response.status}`,
        );
      }
      const root = record(await boundedJson(response));
      const embeddings = root?.embeddings;
      if (!Array.isArray(embeddings) || embeddings.length !== inputs.length) {
        throw new SemanticEmbeddingError(
          "invalid-response",
          "Ollama returned a wrong vector count",
        );
      }
      return embeddings.map(validateVector);
    },
  };
}
