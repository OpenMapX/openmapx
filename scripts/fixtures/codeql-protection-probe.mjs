// Validation-only CodeQL probes for temporary branches. Never import, invoke, or merge this file.
// The Fastify instance is never started; these patterns exist only for hosted static analysis.
import { readFileSync, statSync } from "node:fs";
import Fastify from "fastify";

// Intended High probe: js/file-system-race. This exported function is never called.
export function readLocalValidationFixture(fixturePathname) {
  if (statSync(fixturePathname).isFile()) {
    return readFileSync(fixturePathname);
  }
  return undefined;
}

// Intended Medium probe: js/file-access-to-http. The route reads only a fixed test fixture.
const validationApp = Fastify();
validationApp.get("/codeql-validation-only", (_request, reply) => {
  return reply.send(
    readFileSync(
      "services/data-manager/__tests__/transitous/fixtures/tiny-gtfs/ch_demo/agency.txt",
      "utf8",
    ),
  );
});
