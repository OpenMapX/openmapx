import { SearchIntentSchema, searchIntentJsonSchema } from "../intent-schema";
import { buildSystemPrompt, buildUserMessage } from "../prompt";
import type { NlpProvider, ParseContext } from "../types";

export interface OllamaProviderOptions {
  endpoint: string;
  model: string;
  timeoutMs: number;
  roundDecimals?: number;
  fetchImpl?: typeof fetch;
}

export function createOllamaProvider(opts: OllamaProviderOptions): NlpProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    id: "local",
    requiresNetwork: false,
    async parseQuery(query: string, ctx: ParseContext) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      try {
        const res = await fetchImpl(`${opts.endpoint}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            model: opts.model,
            stream: false,
            format: searchIntentJsonSchema,
            options: { temperature: 0 },
            messages: [
              { role: "system", content: buildSystemPrompt() },
              { role: "user", content: buildUserMessage(query, ctx, opts.roundDecimals ?? 2) },
            ],
          }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`Ollama ${res.status}: ${detail}`);
        }
        const data = (await res.json()) as { message?: { content?: string } };
        const content = data.message?.content;
        if (!content) throw new Error("Ollama returned empty content");
        return SearchIntentSchema.parse(JSON.parse(content));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
