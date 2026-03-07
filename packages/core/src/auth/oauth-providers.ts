export interface OAuthProviderMeta {
  providerId: string;
  name: string;
  icon: string;
}

export const oauthProviders: OAuthProviderMeta[] = [
  {
    providerId: "openstreetmap",
    name: "OpenStreetMap",
    icon: "/osm-logo.svg",
  },
  {
    providerId: "mapillary",
    name: "Mapillary",
    icon: "/mapillary-logo.svg",
  },
];
