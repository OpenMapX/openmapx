import { encryptWithPassphrase, generateKeypair, keypairToJwk } from "@openmapx/mangrove-client";
import { MangroveProvider, type MangroveTransport } from "@openmapx/mangrove-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";
import { PlaceReviewsTab } from "./PlaceReviewsTab";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
const auth = vi.hoisted(() => ({ signedIn: true }));
vi.mock("../../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({
    data: auth.signedIn ? { user: { id: "owner" }, session: { id: "session" } } : null,
  }),
}));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ findDataSource: () => undefined }),
}));
vi.mock("@/components/auth/AuthDialog", () => ({
  AuthDialog: ({ open }: { open: boolean }) => (open ? "auth dialog opened" : null),
}));
vi.mock("./reviews/WriteReviewDialog", () => ({
  WriteReviewDialog: ({ open }: { open: boolean }) => (open ? "review composer ready" : null),
}));
describe("advanced local review choice", () => {
  beforeEach(() => {
    auth.signedIn = true;
  });
  it("lets signed-out users open sign-in through the real signing identity hook", async () => {
    auth.signedIn = false;
    const transport = {
      signer: { getConfig: async () => ({ configured: false }) },
      getKeypairEnvelope: async () => ({ state: "uninitialized" }),
      fetchPlaceReviews: async () => [],
      fetchPlaceReviewAggregate: async () => ({ count: 0, stars: 0 }),
    } as unknown as MangroveTransport;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MangroveProvider transport={transport} currentUser={null}>
          <PlaceReviewsTab
            place={{ id: "osm:node/1", name: "Cafe", coordinates: [6, 50], ids: {} } as never}
          />
        </MangroveProvider>
      </QueryClientProvider>,
    );
    const button = screen.getByRole("button", { name: "place.writeReview" });
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(screen.getByText("auth dialog opened")).toBeVisible();
  });
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
