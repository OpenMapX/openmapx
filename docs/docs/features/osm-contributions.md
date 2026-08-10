---
title: OpenStreetMap contributions
description: Correct a small, safe set of facts on an existing OpenStreetMap place from inside OpenMapX, with your own account.
sidebar_position: 8
---

# OpenStreetMap contributions

Most of what you see in a place panel comes from
[OpenStreetMap](https://www.openstreetmap.org/). When something there is wrong —
a renamed café, a stale phone number, hours that changed last spring — you can
fix it from inside OpenMapX instead of switching to a separate editor.

This is deliberately a small feature. OpenMapX is not a general-purpose map
editor, and it does not try to be one. It transports *your* correction to
OpenStreetMap in a way that keeps the project's public, attributable, verifiable
editing model intact.

## What you can change

Version 1 edits an **existing** OpenStreetMap element and nothing else:

- the **name**
- the **category**, when the current and target categories are both unambiguous
- **address components that are already on that exact element**
- **opening hours**
- **phone**, **email** and **website**
- **wheelchair access**

You can also explicitly **remove** a value you know is wrong, rather than
blanking a box and hoping something happens.

## What it deliberately will not do

Some corrections need more context than this flow can safely collect. Rather
than guess, OpenMapX hands you off to a public note or the full OpenStreetMap
editor:

- **Adding a place that is not in OpenStreetMap yet.**
- **Marking a place closed, demolished or gone.** Lifecycle tagging is a
  judgement call about what replaced it, and doing it badly destroys history.
- **Moving a place** or changing any geometry, shape, or which feature contains
  it.
- **Editing raw tags**, arbitrary presets, several places at once, or several
  elements in one changeset.
- **Social-media links, photos, ownership claims, reviews or private feedback.**

A category the editor cannot resolve unambiguously is also refused. When two
categories match a place equally well, OpenMapX will not pick one for you.

## Live OpenStreetMap is the source of truth

The place panel shows a *merged* view: OpenStreetMap plus whatever enrichment
integrations you have enabled. None of that merged data is ever used to fill an
editor field.

When you open the editor, the server reads the element straight from
OpenStreetMap and shows you those values. It reads it again immediately before
publishing. Everything you see in the editor, and everything that gets sent, is
OpenStreetMap's own current data plus your change.

## Evidence, and what not to copy

OpenStreetMap is built on [verifiable](https://wiki.openstreetmap.org/wiki/Verifiable)
facts, so the review screen asks where your correction comes from:

- you saw it in person,
- it is on a sign at the place,
- it is on the feature's **own** official website, or
- another source you are allowed to use.

**Do not copy from another map, a commercial directory, or a database you do not
have the right to use.** That includes checking a competing map to "confirm" a
name. Doing so puts OpenStreetMap's licensing at risk, and it is the single most
common way well-meant contributions cause real damage.

## Reviewing before you publish

The review screen is mandatory. It shows:

- each change as a plain **old value → new value** row,
- the **exact tag changes** the server will send, expandable,
- your choice of source,
- a **changeset comment you write yourself** — OpenMapX never drafts or
  suggests one for you, because the comment is how other mappers understand
  your edit (see
  [good changeset comments](https://wiki.openstreetmap.org/wiki/Good_changeset_comments)),
- the OpenStreetMap account the edit will be published under, and
- an option to ask another mapper to review it.

Then you press **Publish to OpenStreetMap**.

## It is public, and it is yours

The edit is made with **your** linked OpenStreetMap account. Your username, the
changeset, your comment, your stated source, the resulting tags and your edit
history are all public, and are governed by OpenStreetMap and the OpenStreetMap
Foundation — not by OpenMapX. Deleting your OpenMapX account does not remove
contributions you made to OpenStreetMap.

Contributing requires accepting the
[Contributor Terms](https://osmfoundation.org/wiki/Licence/Contributor_Terms),
which OpenStreetMap asks of everyone who edits.

This is a normal, human-initiated editor. OpenMapX does not make automated or
mechanical edits on your behalf; see the
[automated edits code of conduct](https://wiki.openstreetmap.org/wiki/Automated_Edits_code_of_conduct).

## When someone else edits at the same time

If the element changes in OpenStreetMap while you are working, publishing stops
and shows you what changed upstream. Your correction is kept. You then review it
against the fresh data and publish again deliberately. OpenMapX never quietly
re-applies your edit on top of someone else's.

## Public notes

For anything the editor cannot express — a closed shop, a place in the wrong
spot, something missing — you can leave a public
[note](https://wiki.openstreetmap.org/wiki/Notes) instead. Notes are read by
other mappers, who then make the actual change.

A note is public and attributed to your account, so describe the map-data
problem and **do not include personal or confidential information**. It is not a
support channel for OpenMapX itself.

## Why your change may not show up immediately

OpenStreetMap accepts your edit right away, but OpenMapX and other services
rebuild their own copies of the data on their own schedule. It is normal for a
correction to be live in OpenStreetMap while the place panel still shows the old
value for a while. The success screen links to your changeset so you can confirm
it landed.

## Turning it on

Contributing is **off by default** and requires operator configuration, an
OpenStreetMap OAuth application, and two separate flags. See
[configuration](../install/configuration.md#openstreetmap-contributions) and the
[developer notes](../developer/osm-contributions.md).

## Further reading

- [OpenStreetMap API v0.6](https://wiki.openstreetmap.org/wiki/API_v0.6)
- [OAuth](https://wiki.openstreetmap.org/wiki/OAuth)
- [Changesets](https://wiki.openstreetmap.org/wiki/Changeset)
- [Good practice](https://wiki.openstreetmap.org/wiki/Good_practice)
- [Verifiability](https://wiki.openstreetmap.org/wiki/Verifiable)
- [Notes](https://wiki.openstreetmap.org/wiki/Notes)
- [OSMF privacy policy](https://osmfoundation.org/wiki/Privacy_Policy)
