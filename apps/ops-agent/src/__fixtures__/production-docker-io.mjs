#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { readProductionFixtureCompose } from "./production-compose-config.ts";

const args = process.argv.slice(2);
if (process.env.OMX_PRODUCTION_TEST_DOCKER_TRACE)
  appendFileSync(process.env.OMX_PRODUCTION_TEST_DOCKER_TRACE, JSON.stringify(args) + "\n");
if (args[0] === "compose" && args.includes("config"))
  process.stdout.write(JSON.stringify(readProductionFixtureCompose(args)));
else if (process.env.OMX_PRODUCTION_TEST_DOCKER_READ_ONLY === "1") {
  if (args[0] === "container" && args[1] === "ls") process.stdout.write("");
  else if (args[0] === "ps") process.stdout.write("");
  else if (args[0] === "compose" && args.includes("ps")) process.stdout.write("[]");
  else if (args[0] === "info") process.stdout.write("fixture-empty-host");
  else throw Error("Unexpected effect at the fixture's read-only Docker boundary");
}
