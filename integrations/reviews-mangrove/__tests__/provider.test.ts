import { beforeEach, describe, expect, it, vi } from "vitest";
import { mangroveGetReviews } from "../client.js";
import { mangroveProvider } from "../provider.js";
import type { MangroveWireReview } from "../types.js";

vi.mock("../client.js", () => ({
  mangroveGetReviews: vi.fn(),
  mangroveSubmit: vi.fn(),
  mangroveUploadImage: vi.fn(),
}));

const KID = "-----BEGIN PUBLIC KEY-----test-----END PUBLIC KEY-----";
const OTHER_KID = "-----BEGIN PUBLIC KEY-----other-----END PUBLIC KEY-----";

function wireReview(input: {
  signature?: string;
  kid?: string;
  sub: string;
  iat?: number;
  osmId?: string;
  nickname?: string;
  opinion?: string;
  rating?: number;
  action?: "edit" | "delete" | "report_abuse" | "equivalence";
  originalSub?: string;
  images?: { src: string; label?: string }[];
  license?: string;
}): MangroveWireReview {
  return {
    signature: input.signature ?? "sig",
    jwt: "jwt",
    kid: input.kid ?? KID,
    payload: {
      sub: input.sub,
      iat: input.iat ?? 1_775_485_449,
      rating: input.rating ?? 25,
      opinion: input.opinion ?? "Fries, fries, fries.",
      action: input.action,
      images: input.images,
      metadata: {
        nickname: input.nickname ?? "Schreini",
        osm_id: input.osmId,
        license: input.license,
      },
    },
    original_sub: input.originalSub,
  };
}

const mockedGetReviews = vi.mocked(mangroveGetReviews);

describe("mangroveProvider place matching", () => {
  beforeEach(() => {
    mockedGetReviews.mockReset();
  });

  it("keeps an OSM-linked review on the matching place", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wireReview({
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          osmId: "node/4506022549",
        }),
      ],
    });

    const reviews = await mangroveProvider.getReviews({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "Frittenwerk",
      osmId: "node/4506022549",
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.metadata?.osmId).toBe("node/4506022549");
  });

  it("does not attach an OSM-linked restaurant review to a nearby different POI", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wireReview({
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          osmId: "node/4506022549",
        }),
      ],
    });

    const reviews = await mangroveProvider.getReviews({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "Zahnärzte am Klenkes",
      osmId: "node/999",
    });

    expect(reviews).toEqual([]);
  });

  it("treats explicit OSM mismatches as different places even when names match", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wireReview({
          sub: "geo:50.7750682,6.0877905?q=McDonald's&u=20",
          osmId: "node/1",
        }),
      ],
    });

    const reviews = await mangroveProvider.getReviews({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "McDonald's",
      osmId: "node/2",
    });

    expect(reviews).toEqual([]);
  });

  it("falls back to normalized geo-subject names when OSM metadata is absent", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wireReview({
          sub: "geo:50.7750682,6.0877905?q=Caff%C3%A8%20Milano&u=20",
        }),
      ],
    });

    const matching = await mangroveProvider.getReviews({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "Caffe Milano",
    });

    const unrelated = await mangroveProvider.getReviews({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "McDonald's",
    });

    expect(matching).toHaveLength(1);
    expect(unrelated).toEqual([]);
  });

  it("only accepts nameless geo subjects at a very tight distance", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wireReview({
          sub: "geo:50.7750682,6.0877905?u=5",
        }),
      ],
    });

    const exactPin = await mangroveProvider.getReviews({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "Unknown POI",
    });

    const sameBlock = await mangroveProvider.getReviews({
      lat: 50.7750682 + 30 / 111_320,
      lng: 6.0877905,
      name: "Unknown POI",
    });

    expect(exactPin).toHaveLength(1);
    expect(sameBlock).toEqual([]);
  });

  it("renders the latest edit returned for a geo subject as the original review id", async () => {
    const originalSub = "geo:-21.808294,114.110371?q=Vlamingh%20Head%20Lighthouse&u=30";
    mockedGetReviews
      .mockResolvedValueOnce({
        reviews: [
          wireReview({
            signature: "edit-sig",
            sub: "urn:maresi:original-sig",
            action: "edit",
            originalSub,
            rating: 100,
            opinion: "Edited lighthouse review.",
          }),
        ],
      })
      .mockResolvedValueOnce({
        reviews: [
          wireReview({
            signature: "original-sig",
            sub: originalSub,
            rating: 80,
            opinion: "Original lighthouse review.",
            images: [{ src: "https://files.mangrove.reviews/photo", label: "photo.jpg" }],
            license: "CC-BY-SA-4.0",
          }),
        ],
      });

    const reviews = await mangroveProvider.getReviews({
      lat: -21.808294,
      lng: 114.110371,
      name: "Vlamingh Head Lighthouse",
    });

    expect(mockedGetReviews).toHaveBeenNthCalledWith(2, expect.any(String), {
      limit: 200,
      latestEditsOnly: false,
    });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      id: "original-sig",
      action: undefined,
      targetId: undefined,
      rating: 100,
      opinion: "Edited lighthouse review.",
      images: [{ src: "https://files.mangrove.reviews/photo", label: "photo.jpg" }],
      metadata: { license: "CC-BY-SA-4.0" },
    });
  });

  it("falls back to a latest edit when the original companion read is unavailable", async () => {
    const originalSub = "geo:-21.808294,114.110371?q=Vlamingh%20Head%20Lighthouse&u=30";
    mockedGetReviews
      .mockResolvedValueOnce({
        reviews: [
          wireReview({
            signature: "edit-sig",
            sub: "urn:maresi:original-sig",
            action: "edit",
            originalSub,
            rating: 100,
            opinion: "Edited lighthouse review.",
          }),
        ],
      })
      .mockRejectedValueOnce(new Error("original read failed"));

    const reviews = await mangroveProvider.getReviews({
      lat: -21.808294,
      lng: 114.110371,
      name: "Vlamingh Head Lighthouse",
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      id: "original-sig",
      action: undefined,
      targetId: undefined,
      opinion: "Edited lighthouse review.",
    });
  });

  it("removes deleted reviews when the latest action is a delete", async () => {
    const originalSub = "geo:-21.808294,114.110371?q=Vlamingh%20Head%20Lighthouse&u=30";
    mockedGetReviews
      .mockResolvedValueOnce({
        reviews: [
          wireReview({
            signature: "delete-sig",
            sub: "urn:maresi:original-sig",
            action: "delete",
            originalSub,
          }),
        ],
      })
      .mockResolvedValueOnce({
        reviews: [
          wireReview({
            signature: "original-sig",
            sub: originalSub,
            opinion: "Original lighthouse review.",
          }),
        ],
      });

    const reviews = await mangroveProvider.getReviews({
      lat: -21.808294,
      lng: 114.110371,
      name: "Vlamingh Head Lighthouse",
    });

    expect(reviews).toEqual([]);
  });

  it("collapses duplicate original reviews from the same author-place bucket to the newest", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wireReview({
          signature: "source-copy-1",
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_001,
          osmId: "node/4506022549",
          opinion: "Fries, fries, fries.",
          rating: 20,
        }),
        wireReview({
          signature: "source-copy-2",
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_004,
          osmId: "node/4506022549",
          opinion: "Fries, fries, fries. Updated source copy.",
          rating: 40,
        }),
        wireReview({
          signature: "source-copy-3",
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_003,
          osmId: "node/4506022549",
          opinion: "Fries, fries, fries. Older source copy.",
          rating: 30,
        }),
      ],
    });

    const reviews = await mangroveProvider.getReviews({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "Frittenwerk",
      osmId: "node/4506022549",
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      id: "source-copy-2",
      rating: 40,
      opinion: "Fries, fries, fries. Updated source copy.",
    });
  });

  it("does not collapse imported reviews with different original nicknames", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wireReview({
          signature: "alice-review",
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_001,
          osmId: "node/4506022549",
          nickname: "Alice",
        }),
        wireReview({
          signature: "bob-review",
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_002,
          osmId: "node/4506022549",
          nickname: "Bob",
        }),
      ],
    });

    const reviews = await mangroveProvider.getReviews({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "Frittenwerk",
      osmId: "node/4506022549",
    });

    expect(reviews.map((r) => r.id).sort()).toEqual(["alice-review", "bob-review"]);
  });

  it("does not collapse reviews when the signing keys differ", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wireReview({
          signature: "first-key-review",
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_001,
          osmId: "node/4506022549",
          nickname: "Schreini",
        }),
        wireReview({
          signature: "second-key-review",
          kid: OTHER_KID,
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_002,
          osmId: "node/4506022549",
          nickname: "Schreini",
        }),
      ],
    });

    const reviews = await mangroveProvider.getReviews({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "Frittenwerk",
      osmId: "node/4506022549",
    });

    expect(reviews.map((r) => r.id).sort()).toEqual(["first-key-review", "second-key-review"]);
  });

  it("computes aggregate stats from the deduplicated effective reviews", async () => {
    mockedGetReviews.mockResolvedValue({
      reviews: [
        wireReview({
          signature: "old-same-author",
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_001,
          osmId: "node/4506022549",
          rating: 20,
          opinion: "Old duplicate.",
        }),
        wireReview({
          signature: "new-same-author",
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_002,
          osmId: "node/4506022549",
          rating: 100,
          opinion: "Current duplicate.",
        }),
        wireReview({
          signature: "other-author",
          kid: OTHER_KID,
          sub: "geo:50.7750682,6.0877905?q=Frittenwerk&u=50",
          iat: 1_700_000_003,
          osmId: "node/4506022549",
          rating: 60,
          opinion: "Different author.",
        }),
      ],
    });

    const aggregate = await mangroveProvider.getAggregate({
      lat: 50.7750682,
      lng: 6.0877905,
      name: "Frittenwerk",
      osmId: "node/4506022549",
    });

    expect(aggregate).toMatchObject({
      count: 2,
      opinionCount: 2,
      positiveCount: 2,
      quality: 80,
      stars: 4,
    });
  });
});
