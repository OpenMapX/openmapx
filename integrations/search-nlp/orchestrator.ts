import type { NlpProvider, NlpProviderId, ParseContext, SearchIntent } from "./types";

export interface ChainResult {
  intent: SearchIntent;
  provider: NlpProviderId;
}

export interface Chain {
  parse(query: string, ctx: ParseContext): Promise<ChainResult>;
  providers: NlpProvider[];
}

export function createChain(providers: NlpProvider[]): Chain {
  return {
    providers,
    async parse(query, ctx) {
      const errors: string[] = [];
      for (const p of providers) {
        try {
          return { intent: await p.parseQuery(query, ctx), provider: p.id };
        } catch (err) {
          errors.push(`${p.id}: ${(err as Error).message}`);
        }
      }
      throw new Error(`All NLP providers failed: ${errors.join("; ")}`);
    },
  };
}
