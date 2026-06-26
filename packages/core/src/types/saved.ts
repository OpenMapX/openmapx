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
