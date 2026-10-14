import type { Place, Review, ReviewAggregate } from "@openmapx/core";
import { MangroveProvider, type MangroveTransport } from "@openmapx/mangrove-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "@/test/query";
import { PlaceReviewsTab } from "./PlaceReviewsTab";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { license?: string }) => values?.license ?? key,
  useLocale: () => "en",
}));
vi.mock("../../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({ data: null }),
}));
vi.mock("@openmapx/mangrove-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/mangrove-react")>()),
  useUserKeypair: () => ({ keypair: null, publicPem: null, needsSetup: false, needsUnlock: false }),
}));
const registry = vi.hoisted(() => ({ source: undefined as unknown }));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ findDataSource: () => registry.source }),
}));
vi.mock("@/components/auth/AuthDialog", () => ({ AuthDialog: () => null }));
vi.mock("@/components/auth/MangroveSetupWizard", () => ({ MangroveSetupWizard: () => null }));
vi.mock("@/components/auth/MangroveUnlockDialog", () => ({ MangroveUnlockDialog: () => null }));
vi.mock("./reviews/WriteReviewDialog", () => ({ WriteReviewDialog: () => null }));
vi.mock("./reviews/DeleteReviewDialog", () => ({ DeleteReviewDialog: () => null }));
vi.mock("./reviews/ReportAbuseDialog", () => ({ ReportAbuseDialog: () => null }));

const subject = { lat: 51, lng: 6, name: "Cafe" };
const place = { id: "osm:node/1", coordinates: [6, 51], name: "Cafe", ids: {} } as Place;
const receipt = (sourceId: string) => ({
  sourceId,
  name: `Captured ${sourceId}`,
  url: `https://${sourceId}.test/original`,
});
const review: Review = {
  id: "one",
  subject,
  author: { kid: "public-key", nickname: "Reviewer" },
  createdAt: "2026-10-01T00:00:00Z",
  stars: 4,
  opinion: "Retained opinion",
  source: "reviews",
  contributors: [receipt("reviews")],
  metadata: { license: "CC-BY-SA-4.0" },
};
const aggregate: ReviewAggregate = {
  count: 3,
  opinionCount: 1,
  positiveCount: 3,
  confirmedCount: 0,
  quality: 80,
  stars: 4,
  source: "aggregate",
  contributors: [receipt("aggregate")],
};
const clients: ReturnType<typeof createTestQueryClient>[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  registry.source = undefined;
});

function renderTab(reviews: Review[], summary: ReviewAggregate, pendingAggregate = false) {
  const client = createTestQueryClient();
  clients.push(client);
  const transport: MangroveTransport<Review, ReviewAggregate> = {
    getKeypairEnvelope: async () => null,
    createKeypairEnvelope: async () => {},
    updateKeypairWraps: async () => {},
    deleteKeypairEnvelope: async () => {},
    submitReview: async () => ({ id: "unused" }),
    uploadReviewImage: async () => ({ src: "unused" }),
    fetchPlaceReviews: async () => reviews,
    fetchPlaceReviewAggregate: pendingAggregate ? () => new Promise(() => {}) : async () => summary,
  };
  const view = render(
    <QueryClientProvider client={client}>
      <MangroveProvider transport={transport} currentUser={null}>
        <PlaceReviewsTab place={place} />
      </MangroveProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, transport };
}

describe("displayed review receipts", () => {
  it("keeps cached review/aggregate wording and links after registry disable/change and failed refresh", async () => {
    const { client, transport } = renderTab([review], aggregate);
    await screen.findByText("Retained opinion");
    expect(screen.getByRole("link", { name: "Captured reviews" })).toHaveAttribute(
      "href",
      "https://reviews.test/original",
    );
    expect(screen.getByRole("link", { name: "Captured aggregate" })).toHaveAttribute(
      "href",
      "https://aggregate.test/original",
    );
    registry.source = {
      sourceId: "reviews",
      name: "Changed registry",
      url: "https://changed.test/",
      licensing: {
        version: 1,
        bindings: [{ scope: "data", subject: "Reviews", license: { kind: "unknown" } }],
      },
    };
    transport.fetchPlaceReviews = async () => {
      throw new Error("Refresh failed");
    };
    transport.fetchPlaceReviewAggregate = async () => {
      throw new Error("Refresh failed");
    };
    await act(async () => {
      await client.invalidateQueries();
    });
    registry.source = undefined;
    await act(async () => {
      await client.invalidateQueries();
    });
    expect(screen.getByText("Retained opinion")).toBeVisible();
    expect(screen.getByRole("link", { name: "Captured reviews" })).toHaveAttribute(
      "href",
      "https://reviews.test/original",
    );
    expect(screen.getByRole("link", { name: "Captured aggregate" })).toHaveAttribute(
      "href",
      "https://aggregate.test/original",
    );
    expect(screen.queryByText("Changed registry")).not.toBeInTheDocument();
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((query) => query.state.status === "error"),
    ).toHaveLength(2);
  });

  it("does not credit a hidden zero-count aggregate", async () => {
    renderTab([review], { ...aggregate, count: 0 });
    await screen.findByText("Retained opinion");
    expect(screen.getByRole("link", { name: "Captured reviews" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Captured aggregate" })).not.toBeInTheDocument();
    expect(screen.queryByText("reviewsCount")).not.toBeInTheDocument();
  });

  it("credits the visible list while the aggregate is still a skeleton", async () => {
    renderTab([review], aggregate, true);
    await screen.findByText("Retained opinion");
    expect(screen.getByRole("link", { name: "Captured reviews" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Captured aggregate" })).not.toBeInTheDocument();
  });

  it("never backfills receipt-less or explicitly empty records from current registry metadata", async () => {
    registry.source = {
      sourceId: "reviews",
      name: "Live registry",
      url: "https://live.test/",
      licensing: {
        version: 1,
        bindings: [{ scope: "data", subject: "Reviews", license: { kind: "unknown" } }],
      },
    };
    renderTab([{ ...review, contributors: undefined }], { ...aggregate, contributors: [] });
    await screen.findByText("Retained opinion");
    await waitFor(() => expect(screen.getByText("reviewsCount")).toBeVisible());
    expect(screen.queryByText("Live registry")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Captured reviews" })).not.toBeInTheDocument();
  });

  it("retains the individual review content licence menu", async () => {
    renderTab([review], aggregate);
    await screen.findByText("Retained opinion");
    const menu = screen.getByTestId("MoreVertIcon").closest("button");
    if (!menu) throw new Error("Missing review menu button");
    fireEvent.click(menu);
    expect(await screen.findByRole("menuitem", { name: /CC-BY-SA-4.0/ })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by-sa/4.0/",
    );
  });
});
