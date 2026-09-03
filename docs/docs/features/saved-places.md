---
title: Saved places
description: Save places to lists, label your Home and Work, and export any list as GPX, GeoJSON, or KML.
sidebar_position: 8
---

# Saved places

Signed-in users can keep their own places on the map. The **Save** button on any
[place card](./places.md) adds that place to a list, and the **Saved** panel —
opened from the hamburger menu — is where those places live. Saving is tied to
your account, so your lists follow you across devices.

## Lists and labels

The Saved panel has two tabs:

- **Lists** — collections of places. Every account starts with three built-in
  lists: **Favorites**, **Want to go**, and **Starred places**. You can also
  create your own lists, give them a name and an emoji icon, and add or remove
  places from a list's detail view. Each saved place can carry a free-text
  **note**.
- **Labeled** — single, named places for fast recall, such as **Home** and
  **Work**. Labeled places are set from the **Add a label** row on a place's
  Overview tab, and they surface near the top of search.

## Exporting a list

Any list can be exported to a standard geographic file, so you can take your
places to another tool — a GPS device, a hiking app, Google Earth, or an OSM
editor:

| Format      | Best for                                              | File         |
| ----------- | ----------------------------------------------------- | ------------ |
| **GPX**     | GPS devices and outdoor apps (OsmAnd, Organic Maps…)  | `.gpx`       |
| **GeoJSON** | Web maps, GIS tools, and scripting                    | `.geojson`   |
| **KML**     | Google Earth and Google My Maps                       | `.kml`       |

Open the **Saved** panel, go to the **Lists** tab, open a list, then use the
list's overflow (⋮) menu and choose **Export as GPX**, **Export as GeoJSON**, or
**Export as KML**. The file downloads named after the list (for example
`favorites.gpx`).

Each exported place includes its **name** and **coordinates**, plus its
**address** and **note** where you've set them (these become the description in
GPX and KML). GeoJSON additionally preserves OpenMapX's internal place ID in the
feature properties.

:::note[What exports — and what doesn't]
Export covers the places in a single **list**. Labeled places (Home, Work) and
exporting every list at once aren't part of export yet.
:::

Export is server-side and dependency-free — it reads your own saved places and
runs the converters in the API, so it works on any deployment that has the user
database, with no extra service or credentials.

## Sharing a list

Any list can be published through a **share link** — a short URL
(`https://<your-host>/s/…`) that anyone can open without an account. Open a
list, press **Share**, and choose the link type:

- **Live** — viewers always see the current list, including later edits.
- **Snapshot** — viewers see the list exactly as it was when the link was
  created.

Links can be given an optional expiry (Never, 1, 7, or 30 days), **reset**
(the old URL stops working immediately and a new one is issued), or **deleted**
at any time — revocation is immediate and responses are strictly non-cacheable
(`Cache-Control: no-store`).

A few quotas and security properties apply:

- **Quotas**: Each account may hold up to 100 active share links (`MAX_SHARES_PER_USER = 100`).
  Snapshot links support lists up to 1,000 places (`MAX_SNAPSHOT_PLACES = 1000`).
- **Cryptographic tokens**: Share URLs use 32 random bytes (43 base64url characters).
  Tokens are stored in the database exclusively as SHA-256 hashes; the database never
  stores the raw token.
- **Privacy**: Share pages are excluded from search-engine indexing (`noindex, nofollow`)
  and never expose your username, email, or account ID — only the list name, emoji icon,
  and place entries.

Manage every link you've created under **Account settings → Shared links**.

## Related features

- **[Places & enrichment](./places.md)** — the place card and its **Save**
  button.
- **[Search & autocomplete](./search.md)** — labeled places (Home, Work) surface
  near the top of search results.
