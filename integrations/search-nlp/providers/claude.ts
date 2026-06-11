import { SearchIntentSchema, searchIntentJsonSchema } from "../intent-schema";
import { buildSystemPrompt, buildUserMessage } from "../prompt";
import type { NlpProvider, ParseContext } from "../types";

export interface ClaudeLike {
  messages: {
    create(
      args: unknown,
      options?: unknown,
    ): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

export interface ClaudeProviderOptions {
  model: string;
  timeoutMs: number;
  client: ClaudeLike;
  roundDecimals?: number;
}

export function createClaudeProvider(opts: ClaudeProviderOptions): NlpProvider {
  return {
    id: "claude",
    requiresNetwork: true,
    async parseQuery(query: string, ctx: ParseContext) {
      const response = await opts.client.messages.create(
        {
          model: opts.model,
          max_tokens: 512,
          system: [
            {
              type: "text",
              text: buildSystemPrompt(),
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: [
            {
              role: "user",
              content: buildUserMessage(query, ctx, opts.roundDecimals ?? 2),
            },
          ],
          output_config: {
            format: {
              type: "json_schema",
              schema: searchIntentJsonSchema,
            },
          },
        },
        { timeout: opts.timeoutMs },
      );

      const textBlock = response.content.find((b) => b.type === "text" && b.text);
      if (!textBlock?.text) throw new Error("Claude returned no text block");
      return SearchIntentSchema.parse(JSON.parse(textBlock.text));
    },
  };
}
