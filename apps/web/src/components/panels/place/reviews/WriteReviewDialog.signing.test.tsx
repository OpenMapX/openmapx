import { encryptWithPassphrase, generateKeypair, keypairToJwk } from "@openmapx/mangrove-client";
import { MangroveProvider, type MangroveTransport } from "@openmapx/mangrove-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";
import { WriteReviewDialog } from "./WriteReviewDialog";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("../../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { id: "session" } } }),
}));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ findDataSource: () => undefined }),
}));
vi.mock("@/components/auth/AuthDialog", () => ({ AuthDialog: () => null }));
describe("composer local signing recovery", () => {
  it("offers local unlock after selecting advanced signing while composing", async () => {
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
          <WriteReviewDialog
            open
            onClose={() => undefined}
            subject={{ lat: 50, lng: 6, name: "Cafe" }}
          />
        </MangroveProvider>
      </QueryClientProvider>,
    );
    await userEvent.type(
      screen.getByLabelText("place.reviewPlaceholder"),
      "Draft survives switching",
    );
    await userEvent.click(screen.getByRole("button", { name: "account.mangroveReconnect" }));
    await userEvent.click(screen.getByRole("button", { name: "account.mangroveUseLocal" }));
    await userEvent.click(await screen.findByRole("button", { name: "account.mangroveUnlockCta" }));
    await waitFor(() =>
      expect(screen.getByLabelText("account.mangrovePassphraseLabel")).toBeVisible(),
    );
    expect(screen.queryByText("account.mangroveSetupTitle")).toBeNull();
    await userEvent.type(
      screen.getByLabelText("account.mangrovePassphraseLabel"),
      "passphrase fixture",
    );
    await userEvent.click(screen.getByRole("button", { name: "account.mangroveUnlockCta" }));
    await waitFor(() =>
      expect(screen.queryByLabelText("account.mangrovePassphraseLabel")).toBeNull(),
    );
    expect(screen.getByLabelText("place.reviewPlaceholder")).toHaveValue(
      "Draft survives switching",
    );
  });
});
