---
impacts: [operator-action]
---

## What changes

Installed Android and iOS apps receive shared locations and GPX/GeoJSON/KML files
into a bounded local inbox. Users review content before opening a search or
importing a map overlay. Intake waits for native navigation to end. The iOS Share
Extension saves locally and asks the user to open OpenMapX manually.

## Who is affected

Native app users and mobile release operators. Browser file import, including
`.json`, remains supported. Protocol-3 navigation remains compatible with newer
web/native builds; native intake requires protocol 4 and rebuilt native apps.

## Required action

Deploy the compatible web build before distributing the native update. Register
`<appId>.ShareExtension` and `group.<appId>.intake`, provision the exact App Group
for the host and Share Extension, and regenerate/build with CNG. Do not grant the
navigation widget this group. Qualify Files/mail/cloud-provider delivery on the
intended OS versions and production signing before store distribution.
