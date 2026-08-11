# Review notes and declarations — Google Play

## Background location declaration

Copy verbatim into Play Console → App content → Location permissions.

> OpenMapX uses background location so that turn-by-turn navigation the user has
> explicitly started can keep guiding them while the screen is locked or the app
> is minimised. This is core functionality: without it, guidance stops the moment
> the phone is put in a pocket, which is how people actually navigate.
>
> It is active only during a navigation session the user started by planning a
> route and pressing Start. Arriving, or ending navigation, stops it immediately.
> The user can instead grant foreground-only location; the app then works and
> tells them plainly that guidance pauses when the screen locks.
>
> Position is processed on the device. Coordinates are transmitted only to
> compute a route the user requested, or to compute a new one after they have
> left the route. No location history is kept, and there is no analytics,
> advertising or tracking of any kind.

## Foreground service

Type: `location`. Shown for the duration of an active navigation session, with
an ongoing notification the user can see and use to return to the app. Started
only on an explicit Start, stopped on arrival or End.

## The in-app prominent disclosure

Shown full-screen immediately before the OS prompt, and worded to match this
declaration and the privacy policy:

> **OpenMapX needs your location in the background**
>
> To keep guiding you on the route you just started — including when the screen
> is locked or the app is not in use.
>
> Your position is processed on this device. Coordinates are only sent when you
> ask for a route, or when you have left the route and need a new one.
>
> You can choose "While using the app" instead. Guidance will then pause when
> the screen locks. You can end navigation at any time.

## Data safety

Answers are generated from `apps/mobile/compliance/data-practices.json`; see
`apps/mobile/compliance/google-data-safety-worksheet.md`. Summary: location and
account data are collected; navigation location is processed on-device and not
collected; nothing is shared for advertising; deletion is available in the app
and at https://openmapx.com/delete-account.

## App access

No account required. Every feature including navigation works signed out.

## Reviewer steps

1. Open the app — no permission is requested.
2. Search a destination, choose Directions, tap Start.
3. Read the disclosure, accept, grant the OS prompt.
4. Minimise the app and lock the screen; guidance continues and speaks.
5. The ongoing notification is visible throughout.
6. Return and tap End; location and the notification both stop.

## Other declarations

- Ads: **no**.
- Content rating: completed for a maps and navigation utility.
- Target audience: not directed at children.
- Video demonstrating background location: see
  `background-location-video-script.md`.
