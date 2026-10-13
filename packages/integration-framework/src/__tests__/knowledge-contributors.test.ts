import type { KnowledgeResult } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { withKnowledgeContributors } from "../knowledge-contributors";

it("captures acquisition metadata before an asynchronous lookup settles", async () => {
  const work = Promise.withResolvers<KnowledgeResult>();
  const receipt = { sourceId: "facts", name: "Facts", publisher: { name: "Original publisher" } };
  const secondary = { sourceId: "extract", name: "Extract supplier" };
  const provider = withKnowledgeContributors(
    { name: "mixed", lookup: vi.fn(() => work.promise) },
    () => ({
      uniform: [receipt],
      overrides: { wikipediaExtract: [secondary] },
    }),
  );
  const pending = provider.lookup({});
  receipt.publisher.name = "Changed catalogue";
  work.resolve({
    description: "Short",
    wikipediaExtract: "Long",
    facts: [{ label: "Founded", value: "1900" }],
  });
  const result = await pending;
  expect(result?.fieldContributors?.description[0]?.publisher?.name).toBe("Original publisher");
  expect(result?.fieldContributors?.wikipediaExtract).toEqual([secondary]);
  expect(result?.facts?.[0]?.contributors?.[0]?.publisher?.name).toBe("Original publisher");
});

describe("knowledge adapter trust boundary", () => {
  it("keeps existing empty field and file snapshots authoritative", async () => {
    const provider = withKnowledgeContributors(
      {
        name: "known",
        lookup: vi.fn(async () => ({
          description: "Value",
          fieldContributors: { description: [] },
          photos: [{ url: "https://example.com/file", source: "commons", contributors: [] }],
        })),
      },
      () => ({ uniform: [{ sourceId: "known", name: "Known" }] }),
    );
    const result = await provider.lookup({});
    expect(result?.fieldContributors?.description).toEqual([]);
    expect(result?.photos?.[0]?.contributors).toEqual([]);
    expect(result?.contributors).toEqual([]);
  });
});
