import { useCategorySearchStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { BrandHeaderCard } from "../BrandHeaderCard";

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BrandHeaderCard />
    </QueryClientProvider>,
  );
}

describe("BrandHeaderCard", () => {
  beforeEach(() => {
    useCategorySearchStore.getState().clearCategory();
  });

  it("renders nothing when no brand is active", () => {
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
  });

  it("shows the brand name and description from the store", () => {
    useCategorySearchStore
      .getState()
      .setBrandFilter(
        { qid: "Q41171", name: "Aldi", kind: ["brand"], description: "German supermarket chain" },
        { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
      );
    renderCard();
    expect(screen.getByText("Aldi")).toBeInTheDocument();
    expect(screen.getByText("German supermarket chain")).toBeInTheDocument();
  });
});
