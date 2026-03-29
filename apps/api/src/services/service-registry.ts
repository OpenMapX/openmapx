export interface ServiceDefinition {
  id: string;
  name: string;
  category: string;
  requiredEnvVars: string[];
  available?: () => boolean;
}

const definitions: ServiceDefinition[] = [
  { id: "maptiler", name: "MapTiler", category: "tiles", requiredEnvVars: ["MAPTILER_KEY"] },
  {
    id: "tomtom-traffic",
    name: "TomTom Traffic",
    category: "traffic",
    requiredEnvVars: ["TOMTOM_TRAFFIC_KEY"],
  },
  {
    id: "mapillary",
    name: "Mapillary",
    category: "street-view",
    requiredEnvVars: ["MAPILLARY_TOKEN"],
  },
  { id: "openaq", name: "OpenAQ", category: "air-quality", requiredEnvVars: ["OPENAQ_API_KEY"] },
  {
    id: "firms-wildfires",
    name: "NASA FIRMS",
    category: "wildfires",
    requiredEnvVars: ["FIRMS_MAP_KEY"],
  },
  {
    id: "openchargemap",
    name: "Open Charge Map",
    category: "ev-charging",
    requiredEnvVars: ["OPENCHARGEMAP_API_KEY"],
  },
  {
    id: "tankerkoenig",
    name: "Tankerkoenig",
    category: "fuel",
    requiredEnvVars: ["TANKERKOENIG_API_KEY"],
  },
  { id: "flickr", name: "Flickr", category: "photos", requiredEnvVars: ["FLICKR_API_KEY"] },
  {
    id: "transitland",
    name: "Transit.land",
    category: "transit",
    requiredEnvVars: ["TRANSIT_LAND_API_KEY"],
  },
  {
    id: "tfl",
    name: "Transport for London",
    category: "transit",
    requiredEnvVars: ["TFL_API_KEY"],
  },
  { id: "mbta", name: "MBTA", category: "transit", requiredEnvVars: ["MBTA_API_KEY"] },
  {
    id: "db-ris",
    name: "DB RIS",
    category: "transit",
    requiredEnvVars: ["DB_RIS_CLIENT_ID", "DB_RIS_API_KEY"],
  },
  {
    id: "db-parking",
    name: "DB Parking",
    category: "parking",
    requiredEnvVars: ["DB_PARKING_CLIENT_ID", "DB_PARKING_API_KEY"],
  },
  {
    id: "db-gbfs",
    name: "DB GBFS",
    category: "shared-mobility",
    requiredEnvVars: ["DB_GBFS_CLIENT_ID", "DB_GBFS_API_KEY"],
  },
];

function envIsSet(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== "";
}

class ServiceRegistry {
  private availability: Map<string, boolean>;

  constructor(defs: ServiceDefinition[]) {
    this.availability = new Map();
    for (const def of defs) {
      const envOk = def.requiredEnvVars.every(envIsSet);
      const customOk = def.available ? def.available() : true;
      this.availability.set(def.id, envOk && customOk);
    }
  }

  isAvailable(serviceId: string): boolean {
    return this.availability.get(serviceId) ?? true;
  }

  getAll(): Record<string, boolean> {
    return Object.fromEntries(this.availability);
  }
}

export const serviceRegistry = new ServiceRegistry(definitions);
