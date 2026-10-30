---
title: Saved places
description: Save places to lists, label your Home and Work, import places from files, and export lists as GPX, GeoJSON, or KML.
sidebar_position: 8
---

# Saved places

Signed-in users can keep their own places on the map. The **Save** button on any
[place card](./places.md) adds that place to a list, and the **Saved** panel, opened from the main menu, lets you manage them. Saving is tied to
your account, so your lists follow you across devices.

## Lists and labels

The Saved panel has two tabs:

- **Lists**: collections of places. Every account starts with three built-in
  lists: **Favorites**, **Want to go**, and **Starred places**. You can also
  create your own lists, give them a name and an emoji icon, and add or remove
  places from a list's detail view. Each saved place can carry a free-text
  **note**.
- **Labeled**: single, named places for fast recall, such as **Home** and
  **Work**. Labeled places are set from the **Add a label** row on a place's
  Overview tab, and they surface near the top of search.

## Importing places

In **Saved → Lists**, choose **Import** and select one or more files. To add
places to a particular list, open that list and choose **Import places…** from
its overflow (⋮) menu. Review each detected list, edit its name, and choose a
new list or an existing destination before importing. Existing places with the
same name and nearly identical coordinates are skipped as duplicates.

Supported formats are:

- **Google Takeout ZIP**, individual saved-list **CSV**, and **Saved Places.json**
  from both older and current exports. Unrelated archive contents, including
  reviews, are ignored.
- **KML** and **KMZ** bookmarks, including every KML file inside a KMZ. Folders
  remain together in their document's list. A KML that only links to online data
  must be exported again without the **keep data up to date** option.
- **GPX waypoints** (favourites). Tracks and routes are ignored. A GPX containing
  several waypoint groups becomes one list per group.
- **GeoJSON Point features**, with names, descriptions, and addresses.
- **CSV** with latitude and longitude columns (`lat`/`latitude`/`y` and
  `lon`/`lng`/`long`/`longitude`/`x`), optionally a name/title, note/description/comment,
  and address.

For a Google Takeout export, open [Google Takeout](https://takeout.google.com/),
deselect unrelated products, and include **Saved** for saved lists.
**Maps (your places)** is optional, for older starred places. Non-place saves,
such as films or images saved from search, and empty lists are ignored.
Create and download a ZIP export, then select the whole ZIP in OpenMapX. You can
also select the saved-list CSV files or Saved Places JSON separately. Recognized
Favorites, Want to go, and Starred places lists default to the corresponding
built-in list when it exists; you can change the destination during review.

Files are read in your browser. Missing or approximate locations are looked up
through this server's configured geocoder using the place name and available
address or nearby location. These lookups follow the server's provider settings;
the importer does not contact Google directly. Captured source credits stay with
imported places, including credits for coordinates found by the geocoder. The
review shows the credits that will be saved with the selected places.

**Ready** places have file coordinates or a matching geocoder result.
**Approximate** places retain an estimated location from the export that could
not be verified. They are excluded by default; include them only if that
uncertainty is acceptable. **Not found** places have no usable coordinates and
are skipped; expand the count to see their names. Check the result summary for
imported places, duplicates, and any failures. Successful batches remain saved
if a later batch fails. Each selected file and its expanded archive contents are limited to
200 MiB, with at most 10,000 archive entries.

## Exporting a list

Export a list to use its places in another map or geographic tool:

| Format      | Best for                                             | File       |
| ----------- | ---------------------------------------------------- | ---------- |
| **GPX**     | GPS devices and outdoor apps (OsmAnd, Organic Maps…) | `.gpx`     |
| **GeoJSON** | Web maps, GIS tools, and scripting                   | `.geojson` |
| **KML**     | Google Earth and Google My Maps                      | `.kml`     |

Open the **Saved** panel, go to the **Lists** tab, open a list, then use the
list's overflow (⋮) menu and choose **Export as GPX**, **Export as GeoJSON**, or
**Export as KML**. The file downloads named after the list (for example
`favorites.gpx`).

Each exported place includes its **name** and **coordinates**, plus its
**address** and **note** where you've set them (these become the description in
GPX and KML). GeoJSON additionally preserves OpenMapX's internal place ID in the
feature properties.

OpenMapX preserves captured source credits through GPX, KML, and GeoJSON export
and re-import. Its exports also keep addresses separate from personal notes, so
re-importing a list does not add generated credits or address lines to your notes.

:::note[Export scope]
Export covers the places in a single **list**. Labeled places (Home, Work) and
exporting every list at once aren't part of export yet.
:::

## How saved data is protected

Signed-in lists, labels, names, coordinates, addresses, notes, and place metadata
are stored as server-readable rows in this deployment's PostgreSQL database.
Use HTTPS to protect them in transit. Private saved-data API requests are scoped
to the signed-in account. The content is **not end-to-end encrypted**: the API and an operator
with database access can read it. Database backups retain the rows that existed
when each backup was made, until the operator's backup-retention period expires.

See [Accounts and your data](./accounts-and-privacy.md) for data-access requests
and account deletion, and the [user-data trust model](../developer/user-data-trust-model.md)
for implementation details.

## Sharing a list

Any list can be published through a **share link**, a short URL
(`https://<your-host>/s/…`) that anyone can open without an account. Open a
list, press **Share**, and choose the link type:

- **Live**: viewers always see the current list, including later edits.
- **Snapshot**: viewers see the list exactly as it was when the link was
  created.

Links can be given an optional expiry (Never, 1, 7, or 30 days), **reset**
(the old URL stops working immediately and a new one is issued), or **deleted**
at any time. Revocation is immediate and responses are non-cacheable
(`Cache-Control: no-store`).

Each account can hold 100 share links, including expired links until deleted.
Snapshot lists support at most 1,000 places. Live list reads also return at most
1,000 entries, so use smaller lists when sharing a large collection.

Anyone with the URL can read the shared content. The page omits account identity
and asks search engines not to index it; that does not prevent recipients from
copying or forwarding it. Place names, notes, addresses, and locations can still
identify you. Review them before creating a link.

The database stores a hash of the bearer token, while the list or snapshot
content remains readable to the server. A revoked link cannot retract copies a
recipient already saved.

Manage every link you've created under **Account settings → Shared links**.

## Related features

- **[Places & enrichment](./places.md)**: the place card and its **Save**
  button.
- **[Search & autocomplete](./search.md)**: labeled places (Home, Work) surface
  near the top of search results.
