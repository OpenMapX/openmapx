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
`.json`, remains supported. The page and the installed app speak one bridge
protocol version; an app built for a different version shows "Update the app"
until it is replaced.

## Required action

Ship the web deploy and the rebuilt phone build together. Register
`<appId>.ShareExtension` and `group.<appId>.intake`, provision the exact App Group
for the host and Share Extension, and regenerate/build with CNG. Do not grant the
navigation widget this group. Qualify Files/mail/cloud-provider delivery on the
intended OS versions and production signing before store distribution.
