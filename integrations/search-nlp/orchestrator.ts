import type { NlpProvider, ParseContext, SearchIntent } from "./types";

export interface ChainResult {
  intent: SearchIntent;
  provider: {
    id: string;
    label: string;
    cloud: boolean;
  };
}

export interface Chain {
  parse(query: string, ctx: ParseContext): Promise<ChainResult>;
  providers: NlpProvider[];
}

export interface ChainOptions {
  onProviderFailure?: (provider: NlpProvider, error: unknown) => void | Promise<void>;
}

export function createChain(providers: NlpProvider[], options: ChainOptions = {}): Chain {
  return {
    providers,
    async parse(query, ctx) {
      const errors: string[] = [];
      for (const p of providers) {
        try {
          return {
            intent: await p.parseQuery(query, ctx),
            provider: { id: p.id, label: p.label, cloud: p.requiresNetwork },
          };
        } catch (err) {
          await options.onProviderFailure?.(p, err);
          errors.push(`${p.id}: ${(err as Error).message}`);
        }
      }
      throw new Error(`All NLP providers failed: ${errors.join("; ")}`);
    },
  };
}
