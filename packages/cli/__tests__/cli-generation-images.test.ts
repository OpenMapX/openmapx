import { beforeEach, expect, it, vi } from "vitest";
import { localImageIds, pulledImageIds } from "../src/lib/docker";

const id = (digit: string) => `sha256:${digit.repeat(64)}`;
let images: Map<string, string>;
let pullable: Map<string, string>;
const calls: string[][] = [];
vi.mock("execa", async (original) => ({
  ...(await original<typeof import("execa")>()),
  execa: vi.fn(async (name: string, args: string[]) => {
    if (name !== "docker") throw Error("Unexpected external process");
    calls.push(args);
    const reference = args.at(-1) ?? "";
    if (args[0] === "image" && args[1] === "inspect") {
      const found = images.get(reference);
      if (!found) throw Error("No such image");
      return { stdout: found, exitCode: 0 };
    }
    if (args[0] === "pull") {
      const pulled = pullable.get(reference);
      if (!pulled) return { stdout: "", exitCode: 1 };
      images.set(reference, pulled);
      return { stdout: "", exitCode: 0 };
    }
    throw Error(`Unexpected docker ${args.join(" ")}`);
  }),
}));

beforeEach(() => {
  calls.length = 0;
  images = new Map([["example/app-api:1", id("a")]]);
  pullable = new Map([["example/data-manager:1", id("d")]]);
});

const references = {
  "app-api": "example/app-api:1",
  "data-manager": "example/data-manager:1",
  "local-ai": "example/local-ai:dev",
};

it("records only the images already on the host without pulling", async () => {
  expect(await localImageIds(references)).toEqual({ "app-api": id("a") });
  expect(calls.some((args) => args[0] === "pull")).toBe(false);
});

it("pulls the images a starting generation lacks and records them; an unpullable one stays out", async () => {
  expect(await pulledImageIds(references)).toEqual({
    "app-api": id("a"),
    "data-manager": id("d"),
  });
  expect(calls.filter((args) => args[0] === "pull")).toEqual([
    ["pull", "example/data-manager:1"],
    ["pull", "example/local-ai:dev"],
  ]);
});

it("pulls nothing when every image is present", async () => {
  pullable.clear();
  images.set("example/data-manager:1", id("d"));
  images.set("example/local-ai:dev", id("e"));
  expect(await pulledImageIds(references)).toEqual({
    "app-api": id("a"),
    "data-manager": id("d"),
    "local-ai": id("e"),
  });
  expect(calls.some((args) => args[0] === "pull")).toBe(false);
});
