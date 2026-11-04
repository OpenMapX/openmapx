import {
  captureReviewProviderContributors,
  type IntegrationContext,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import type { ReviewProvider } from "@openmapx/integration-reviews/types";
import { contributorKey, contributorsForRecords } from "@openmapx/mobility-core/contributors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mangroveGetReviews } from "../client.js";
import { setup } from "../index.js";
import manifest from "../manifest.json" with { type: "json" };
import type { MangroveWirePayload, MangroveWireReview } from "../types.js";

vi.mock("@openmapx/mangrove-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/mangrove-client")>();
  return {
    ...actual,
    verifyMangroveReview: vi.fn(async ({ jwt, kid }: { jwt: string; kid?: string }) => ({
      ok: true as const,
      kid: kid ?? "",
      payload: JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")),
    })),
  };
});

vi.mock("../client.js", () => ({
  mangroveGetReviews: vi.fn(),
  mangroveSubmit: vi.fn(),
  mangroveUploadImage: vi.fn(),
}));

const SUBJECT = {
  lat: 52.3896008,
  lng: 9.7498513,
  name: "Mangals Kitchen",
  osmId: "node/1295702455",
};
const SUB = "geo:52.3896008,9.7498513?q=Mangals%20Kitchen&u=50";

function wire(input: {
  signature: string;
  kid?: string;
  license?: string;
  action?: "edit";
  target?: string;
  iat?: number;
}): MangroveWireReview {
  const payload: MangroveWirePayload = {
    sub: input.target ? `urn:maresi:${input.target}` : SUB,
    iat: input.iat ?? 1_775_485_449,
    rating: 100,
    opinion: `Review ${input.signature}`,
    action: input.action,
    metadata: { nickname: input.kid ?? "Nortix", osm_id: SUBJECT.osmId, license: input.license },
  };
  return {
    signature: input.signature,
    jwt: `test.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.test`,
    kid: input.kid ?? "author",
    payload,
    original_sub: input.target ? SUB : undefined,
  };
}

/** The review provider exactly as the reviews orchestrator reads it. */
function registeredProvider(): { provider: ReviewProvider; ctx: IntegrationContext } {
  const ctx = createMockIntegrationContext({
    id: "reviews-mangrove",
    manifest: structuredClone(manifest) as unknown as IntegrationContext["manifest"],
  });
  setup(ctx);
  const [provider] = ctx.registered.review as ReviewProvider[];
  return { provider: captureReviewProviderContributors(ctx, provider), ctx };
}

const mockedGetReviews = vi.mocked(mangroveGetReviews);

describe("Mangrove review licence credits", () => {
  beforeEach(() => mockedGetReviews.mockReset());

  it("credits a CC BY-SA review under CC BY-SA 4.0 with the source's name and link", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [wire({ signature: "sa", license: "CC-BY-SA-4.0" })],
    });
    const [review] = await registeredProvider().provider.getReviews(SUBJECT);

    expect(review.metadata?.license).toBe("CC-BY-SA-4.0");
    expect(review.contributors).toEqual([
      {
        sourceId: "mangrove",
        name: "Mangrove.reviews",
        url: "https://mangrove.reviews/",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Mangrove.reviews material",
              license: {
                kind: "spdx",
                expression: "CC-BY-SA-4.0",
                url: "https://creativecommons.org/licenses/by-sa/4.0/",
              },
            },
          ],
          declarations: [
            { text: "CC-BY-SA-4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" },
          ],
        },
      },
    ]);
  });

  it("credits reviews that state CC BY 4.0 or no licence with the source's own CC BY 4.0 credit", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wire({ signature: "by", kid: "a", license: "CC-BY-4.0" }),
        wire({ signature: "unstated", kid: "b" }),
      ],
    });
    const reviews = await registeredProvider().provider.getReviews(SUBJECT);
    const credits = contributorsForRecords(reviews);

    expect(credits).toHaveLength(1);
    expect(credits[0].licensing?.bindings.map((binding) => binding.license)).toEqual([
      {
        kind: "spdx",
        expression: "CC-BY-4.0",
        url: "https://creativecommons.org/licenses/by/4.0/",
      },
    ]);
  });

  it("credits each licence once when a place shows reviews under both", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wire({ signature: "sa", kid: "a", license: "CC-BY-SA-4.0" }),
        wire({ signature: "by", kid: "b" }),
      ],
    });
    const reviews = await registeredProvider().provider.getReviews(SUBJECT);
    const credits = contributorsForRecords(reviews);

    expect(
      credits.map((credit) =>
        credit.licensing?.bindings.map((b) => b.license.kind === "spdx" && b.license.expression),
      ),
    ).toEqual([["CC-BY-SA-4.0"], ["CC-BY-4.0"]]);
    expect(new Set(credits.map(contributorKey)).size).toBe(2);
  });

  it("follows the licence an edit states", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wire({ signature: "original", iat: 1_700_000_000 }),
        wire({
          signature: "edit",
          action: "edit",
          target: "original",
          license: "CC-BY-SA-4.0",
          iat: 1_700_000_100,
        }),
      ],
    });
    const [review] = await registeredProvider().provider.getReviews(SUBJECT);

    expect(review.id).toBe("original");
    expect(review.metadata?.license).toBe("CC-BY-SA-4.0");
    expect(review.contributors?.[0]?.licensing?.bindings[0]?.license).toMatchObject({
      expression: "CC-BY-SA-4.0",
    });
  });

  it("keeps the aggregate's source credit, marked as changed", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [wire({ signature: "sa", license: "CC-BY-SA-4.0" })],
    });
    const aggregate = await registeredProvider().provider.getAggregate(SUBJECT);

    expect(aggregate.contributors).toEqual([
      expect.objectContaining({
        sourceId: "mangrove",
        modified: true,
        licensing: expect.objectContaining({
          bindings: [
            expect.objectContaining({
              license: expect.objectContaining({ expression: "CC-BY-4.0" }),
            }),
          ],
        }),
      }),
    ]);
  });

  it("reads the source credit before awaiting the upstream", async () => {
    const pending = Promise.withResolvers<{ reviews: MangroveWireReview[] }>();
    mockedGetReviews.mockReturnValue(pending.promise as never);
    const { provider, ctx } = registeredProvider();
    const read = provider.getReviews(SUBJECT);
    const source = ctx.manifest.dataSources?.[0];
    if (!source) throw new Error("Missing Mangrove source");
    source.name = "Changed supplier";
    pending.resolve({ reviews: [wire({ signature: "sa", license: "CC-BY-SA-4.0" })] });

    expect((await read)[0].contributors?.[0]?.name).toBe("Mangrove.reviews");
  });
});
