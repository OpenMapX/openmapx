import type { Place, Review, ReviewAggregate } from "@openmapx/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PlaceReviewsTab } from "./PlaceReviewsTab";

const state = vi.hoisted(() => ({
  reviews: { data: undefined as Review[] | undefined, isLoading: true },
  aggregate: { data: undefined as ReviewAggregate | undefined, isLoading: true },
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("../../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({ data: null }),
}));
vi.mock("@openmapx/mangrove-react", () => ({
  useMangroveSigner: () => ({ config: { configured: false } }),
  useKeypairStore: { getState: () => ({ clear: () => {} }) },
  useReviewIdentity: () => ({}),
  usePlaceReviews: () => state.reviews,
  useReviewAggregate: () => state.aggregate,
}));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ findDataSource: () => undefined }),
}));
vi.mock("@/components/auth/AuthDialog", () => ({ AuthDialog: () => null }));
vi.mock("@/components/auth/MangroveSetupWizard", () => ({ MangroveSetupWizard: () => null }));
vi.mock("@/components/auth/MangroveUnlockDialog", () => ({ MangroveUnlockDialog: () => null }));
vi.mock("./reviews/WriteReviewDialog", () => ({ WriteReviewDialog: () => null }));
vi.mock("./reviews/DeleteReviewDialog", () => ({ DeleteReviewDialog: () => null }));
vi.mock("./reviews/ReportAbuseDialog", () => ({ ReportAbuseDialog: () => null }));
const reviewBase: Review = {
  id: "one",
  subject: { lat: 51, lng: 6, name: "Cafe" },
  author: { kid: "public-key" },
  createdAt: "2026-10-01T00:00:00Z",
};
const aggregateBase: ReviewAggregate = {
  count: 2,
  stars: 0,
  opinionCount: 1,
  positiveCount: 1,
  confirmedCount: 0,
  quality: 0,
};
const place = { id: "osm:node/1", coordinates: [6, 51], name: "Cafe", ids: {} } as Place;
beforeEach(() => {
  state.reviews = { data: undefined, isLoading: true };
  state.aggregate = { data: undefined, isLoading: true };
});
it("credits review-derived distribution and fallback stars even when the list is hidden", () => {
  state.reviews = {
    data: [
      { ...reviewBase, stars: 4, contributors: [{ sourceId: "rated", name: "Rated supplier" }] },
      {
        ...reviewBase,
        id: "unrated",
        opinion: "Hidden unrated text",
        contributors: [{ sourceId: "unrated", name: "Unrated supplier" }],
      },
    ],
    isLoading: true,
  };
  state.aggregate = {
    data: {
      ...aggregateBase,
      stars: 0,
      contributors: [{ sourceId: "aggregate", name: "Aggregate supplier" }],
    },
    isLoading: false,
  };
  render(<PlaceReviewsTab place={place} />);
  expect(screen.getByText("4.0")).toBeVisible();
  expect(screen.getByText("Rated supplier")).toBeVisible();
  expect(screen.getByText("Aggregate supplier")).toBeVisible();
  expect(screen.queryByText("Unrated supplier")).not.toBeInTheDocument();
  expect(screen.queryByText("Hidden unrated text")).not.toBeInTheDocument();
});
it("does not credit retained query data while both surfaces show skeletons", () => {
  state.reviews.data = [
    { ...reviewBase, stars: 4, contributors: [{ sourceId: "rated", name: "Rated supplier" }] },
  ];
  state.aggregate.data = {
    ...aggregateBase,
    stars: 4,
    contributors: [{ sourceId: "aggregate", name: "Aggregate supplier" }],
  };
  render(<PlaceReviewsTab place={place} />);
  expect(screen.queryByText("Rated supplier")).not.toBeInTheDocument();
  expect(screen.queryByText("Aggregate supplier")).not.toBeInTheDocument();
});
