export interface SavedList {
  id: string;
  name: string;
  icon: string | null;
  isPrivate: boolean;
  sortOrder: number;
  placeCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SavedPlace {
  id: string;
  listId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  placeId: string | null;
  note: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface LabeledPlace {
  id: string;
  label: string;
  icon: string | null;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  placeId: string | null;
}

/**
 * Runtime shape check for a {@link LabeledPlace}. The API always returns valid
 * rows (the columns are `NOT NULL`), but the offline saved-places mirror can
 * hold entries persisted by an older app version whose shape predates the
 * current one (e.g. the legacy `{ id: "home" }` quick-label with no `label`/
 * `name`). Validate such persisted data before it reaches consumers that assume
 * `label`/`name` are present strings.
 */
export function isLabeledPlace(value: unknown): value is LabeledPlace {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.name === "string" &&
    typeof v.lat === "number" &&
    typeof v.lng === "number"
  );
}
