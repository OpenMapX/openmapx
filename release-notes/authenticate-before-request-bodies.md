---
impacts: [security]
---

## What changes

The API now checks a caller's credentials before it reads the request body on
routes that need a signed-in user or an administrator, and on integration routes
that require a session. A caller without valid credentials gets 401 or 403
without the server buffering anything they send.

Request bodies are limited to 1 MiB unless a route declares a larger limit. The
saved-places import accepts up to 8 MiB (it accepted 40 MiB before), the review
photo upload up to 7 MiB, and the road-flow route up to 4 MiB. Integration routes
are held to 1 MiB unless they declare a limit with the new `bodyLimit` route
option, which the host caps at 8 MiB.

A request whose body has not fully arrived 60 seconds after it began has its
connection closed. Administrator artifact transfers, which stream for as long as
the transfer takes, are exempt.

## Who is affected

Every installation. Ordinary use stays well inside the limits: an import of 2,000
saved places is under a megabyte. Scripts or custom clients that send a
saved-places import above 8 MiB, or any other request above its route's limit,
now receive 413.

## Required action

None. Update as usual.
