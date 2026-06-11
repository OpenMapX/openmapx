import { SearchIntentSchema, searchIntentJsonSchema } from "../intent-schema";
import { buildSystemPrompt, buildUserMessage } from "../prompt";
import type { NlpProvider, ParseContext } from "../types";

export interface OpenAiLike {
  chat: {
    completions: {
      create(
        args: unknown,
        options?: unknown,
      ): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
}

export interface OpenAiProviderOptions {
  model: string;
  timeoutMs: number;
  client: OpenAiLike;
  roundDecimals?: number;
}

export function createOpenAiProvider(opts: OpenAiProviderOptions): NlpProvider {
  return {
    id: "openai",
    requiresNetwork: true,
    async parseQuery(query: string, ctx: ParseContext) {
      const response = await opts.client.chat.completions.create(
        {
          model: opts.model,
          temperature: 0,
          messages: [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildUserMessage(query, ctx, opts.roundDecimals ?? 2) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "search_intent",
              strict: true,
              schema: searchIntentJsonSchema,
            },
          },
        },
        { timeout: opts.timeoutMs },
      );

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("OpenAI returned empty content");
      return SearchIntentSchema.parse(JSON.parse(content));
    },
  };
}
