import type { FareProduct, TripFare } from "@openmapx/mobility-core/transit";

export interface FareSummary {
  amount: number;
  currency: string;
  products: FareProduct[];
  byCategory: Array<{ name: string; amount: number; isDefault: boolean }>;
}

export function extractFareSummary(fare: TripFare | undefined): FareSummary | null {
  if (!fare?.transfers?.length) return null;

  const allProducts: FareProduct[] = [];

  for (const transfer of fare.transfers) {
    if (transfer.transferProducts) {
      allProducts.push(...transfer.transferProducts);
    }
    for (const legOptions of transfer.legProducts) {
      for (const [firstOption] of legOptions) {
        if (firstOption) allProducts.push(firstOption);
      }
    }
  }

  const [firstProduct] = allProducts;
  if (!firstProduct) return null;

  const currency = firstProduct.currency;

  const categoryMap = new Map<string, { name: string; amount: number; isDefault: boolean }>();
  for (const p of allProducts) {
    const catName = p.riderCategory?.name ?? "Standard";
    const isDefault = p.riderCategory?.isDefault !== false;
    const existing = categoryMap.get(catName);
    if (existing) {
      existing.amount += p.amount;
    } else {
      categoryMap.set(catName, { name: catName, amount: p.amount, isDefault });
    }
  }

  const byCategory = Array.from(categoryMap.values());
  // At least one product exists, so its category does too.
  const defaultCat = byCategory.find((c) => c.isDefault) ?? byCategory[0];
  if (!defaultCat) throw new Error("A fare with products has no rider category");

  return {
    amount: defaultCat.amount,
    currency,
    products: allProducts,
    byCategory,
  };
}

export function formatFare(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
