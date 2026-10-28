import { encryptWithPassphrase, generateKeypair, keypairToJwk } from "@openmapx/mangrove-client";
import { MangroveProvider, type MangroveTransport } from "@openmapx/mangrove-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";
import { PlaceReviewsTab } from "./PlaceReviewsTab";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("../../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { id: "session" } } }),
}));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ findDataSource: () => undefined }),
}));
vi.mock("@/components/auth/AuthDialog", () => ({ AuthDialog: () => null }));
vi.mock("./reviews/WriteReviewDialog", () => ({
  WriteReviewDialog: ({ open }: { open: boolean }) => (open ? "review composer ready" : null),
}));
describe("advanced local review choice", () => {
  it("keeps the pending write and unlocks an existing local key instead of recreating it", async () => {
    sessionStorage.clear();
    const jwk = await keypairToJwk(await generateKeypair());
    const ciphertext = await encryptWithPassphrase(jwk.privateJwk, "passphrase fixture");
    const transport = {
      signer: {
        getConfig: async () => ({ configured: false }),
        getAccount: async () => {
          throw new Error("unused");
        },
        signReview: async () => {
          throw new Error("unused");
        },
        revokeSession: async () => undefined,
      },
      getKeypairEnvelope: async () => ({
        state: "ready",
        revision: "r1",
        publicJwk: jwk.publicJwk,
        passphraseCiphertext: ciphertext,
        recipientsCiphertext: null,
        wraps: [
          {
            id: "pass",
            wrapType: "passphrase",
            label: "Passphrase",
            identityString: null,
            createdAt: "2026-01-01",
          },
        ],
      }),
      fetchPlaceReviews: async () => [],
      fetchPlaceReviewAggregate: async () => ({ count: 0, stars: 0 }),
    } as unknown as MangroveTransport;
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MangroveProvider
          transport={transport}
          currentUser={{ id: "owner", authorityId: "session" }}
        >
          <PlaceReviewsTab
            place={{ id: "osm:node/1", name: "Cafe", coordinates: [6, 50], ids: {} } as never}
          />
        </MangroveProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "place.writeReview" }));
    await userEvent.click(screen.getByRole("button", { name: "account.mangroveUseLocal" }));
    await waitFor(() =>
      expect(screen.getByLabelText("account.mangrovePassphraseLabel")).toBeVisible(),
    );
    expect(screen.queryByText("account.mangroveSetupTitle")).toBeNull();
    await userEvent.type(
      screen.getByLabelText("account.mangrovePassphraseLabel"),
      "passphrase fixture",
    );
    await userEvent.click(screen.getByRole("button", { name: "account.mangroveUnlockCta" }));
    await waitFor(() => expect(screen.getByText("review composer ready")).toBeVisible());
  });
});
