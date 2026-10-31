import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** Named external Compose read, from the test's actual generated files and overlay. */
export function readProductionFixtureCompose(args: readonly string[]) {
  if (args[0] !== "compose" || !args.includes("config"))
    throw Error("Expected a named Compose configuration read");
  const services: Record<string, Record<string, unknown>> = {};
  let files = 0;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "-f") continue;
    const source = parse(readFileSync(args[++index]!, "utf8")) as {
      services?: Record<string, Record<string, unknown>>;
    };
    for (const [id, definition] of Object.entries(source.services ?? {}))
      services[id] = { ...services[id], ...definition };
    files++;
  }
  if (!files || !Object.keys(services).length) throw Error("Fixture Compose input unavailable");
  return { services };
}
