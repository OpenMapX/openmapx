interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface ReviewDraft {
  stars: number | null;
  opinion: string;
  images: { src: string; label?: string }[];
  experience: string | null;
  isAffiliated: boolean;
  license: "CC-BY-4.0" | "CC-BY-SA-4.0";
}
const KEY = "openmapx.mangrove.draft";
/** One per-tab reconnect draft, scoped to the exact account session and subject. */
export function saveReviewDraft(
  storage: DraftStorage,
  ownerSubject: string,
  draft: ReviewDraft,
  now = Date.now(),
): void {
  storage.setItem(
    KEY,
    JSON.stringify({
      ownerSubject,
      createdAt: now,
      stars: draft.stars,
      opinion: draft.opinion.slice(0, 1000),
      images: draft.images.slice(0, 5),
      experience: draft.experience,
      isAffiliated: draft.isAffiliated,
      license: draft.license,
    }),
  );
}
export function takeReviewDraft(
  storage: DraftStorage,
  ownerSubject: string,
  now = Date.now(),
): ReviewDraft | null {
  try {
    const text = storage.getItem(KEY);
    if (!text || text.length > 30000) return null;
    const value = JSON.parse(text);
    if (value.ownerSubject !== ownerSubject) return null;
    storage.removeItem(KEY);
    if (
      typeof value.createdAt !== "number" ||
      now - value.createdAt > 3600000 ||
      value.createdAt > now ||
      typeof value.opinion !== "string" ||
      value.opinion.length > 1000 ||
      !Array.isArray(value.images) ||
      value.images.length > 5 ||
      !value.images.every(
        (image: unknown) =>
          image &&
          typeof image === "object" &&
          typeof (image as { src?: unknown }).src === "string",
      ) ||
      (value.stars !== null &&
        (!Number.isInteger(value.stars) || value.stars < 0 || value.stars > 5)) ||
      (value.license !== "CC-BY-4.0" && value.license !== "CC-BY-SA-4.0") ||
      (value.experience !== null && typeof value.experience !== "string") ||
      typeof value.isAffiliated !== "boolean"
    )
      return null;
    return {
      stars: value.stars,
      opinion: value.opinion,
      images: value.images,
      experience: value.experience,
      isAffiliated: value.isAffiliated,
      license: value.license,
    };
  } catch {
    return null;
  }
}
