import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OpenMapX",
    short_name: "OpenMapX",
    description: "Self-hostable, open-data maps — search, directions, and transit",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone", "browser"],
    orientation: "any",
    background_color: "#f5f5f5",
    theme_color: "#007b8b",
    lang: "en",
    dir: "ltr",
    categories: ["navigation", "travel", "utilities", "maps"],
    icons: [
      {
        src: "/icons/app/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/app/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/app/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icons/app/icon-monochrome-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "monochrome",
      },
    ],
    shortcuts: [
      {
        name: "Search",
        short_name: "Search",
        description: "Search for a place",
        url: "/?action=search",
        icons: [{ src: "/icons/app/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Directions",
        short_name: "Directions",
        description: "Get directions",
        url: "/?action=directions",
        icons: [{ src: "/icons/app/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Saved places",
        short_name: "Saved",
        description: "Open your saved places",
        url: "/?panel=saved",
        icons: [{ src: "/icons/app/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Offline maps",
        short_name: "Offline",
        description: "Manage downloaded offline areas",
        url: "/settings/offline",
        icons: [{ src: "/icons/app/icon-192.png", sizes: "192x192" }],
      },
    ],
    share_target: {
      action: "/share",
      method: "GET",
      enctype: "application/x-www-form-urlencoded",
      params: {
        title: "title",
        text: "text",
        url: "url",
      },
    },
    // Handle geo: URIs (RFC 5870) — clicking a geo: link opens OpenMapX.
    protocol_handlers: [
      {
        protocol: "geo",
        url: "/?geo=%s",
      },
      {
        protocol: "web+maps",
        url: "/?geo=%s",
      },
    ],
    launch_handler: {
      client_mode: ["focus-existing", "auto"],
    },
    // Open GPX / GeoJSON / KML files with OpenMapX (draws them on the map).
    // `.json` is deliberately excluded — too generic to claim from the OS.
    file_handlers: [
      {
        action: "/",
        accept: {
          "application/gpx+xml": [".gpx"],
          "application/geo+json": [".geojson"],
          "application/vnd.google-earth.kml+xml": [".kml"],
        },
      },
    ],
  } satisfies MetadataRoute.Manifest;
}
