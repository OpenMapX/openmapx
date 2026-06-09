---
title: Reviews
description: Read and write place reviews over Mangrove, an open and federated review network where you hold your own signing key.
sidebar_position: 8
---

# Reviews

Reviews let you see what other people thought of a place — a star rating, a few
words, sometimes a photo — and add your own. They live on the **Reviews** tab of
every [place panel](./places.md), next to the place's hours, contact details, and
photos.

What makes reviews here different from a typical maps app is where the data comes
from and who owns it. OpenMapX does not run a review database. Ratings and
written reviews are read from [Mangrove](https://mangrove.reviews/), an open,
federated reviews network, and when you write one it is signed in your browser
with a key that only you hold. Your reviews are not locked to OpenMapX — any
application that speaks the same open standard can read them, and you can take
your identity with you.

## What you get

- **Community ratings and reviews** — the Reviews tab shows an aggregate (an
  average star rating and how many people rated the place) and the individual
  reviews beneath it, newest first. Reviews carry the author's chosen nickname,
  the rating, the written opinion, and any attached photos.
- **Your own reviews** — sign in, set up a signing key once, and you can post a
  rating and opinion, attach photos, then edit or delete what you wrote later.
- **One review per place, per identity** — your own review is highlighted, and
  the **Write a review** button becomes **Edit** once you've reviewed a place, so
  you update your opinion rather than stacking duplicates.
- **Links out to other platforms** — where a place has a known presence
  elsewhere, the tab can also surface links to find reviews on other sites, so an
  empty Mangrove result isn't a dead end.

## How it works

### Reviews come from Mangrove

[Mangrove](https://mangrove.reviews/) is an open dataset and protocol for
reviews. Anyone can read it, anyone can contribute, and no single company owns
the data — it is published under a permissive **Creative Commons** license. Other
clients (including Mangrove's own site) read and write the same pool, so a review
written in OpenMapX is visible to them and vice versa.

OpenMapX talks to Mangrove through a small built-in integration — `reviews` is
the orchestrator that merges results, and `reviews-mangrove` is the provider that
actually speaks to the Mangrove API. Like every other upstream call in the stack,
review reads are proxied through your own API server and cached, so Mangrove sees
your server rather than each visitor. See
[Introduction](../overview/introduction.md) for what an integration is, and
[How it works](../overview/how-it-works.md) for how integrations consume external
APIs.

### A place is addressed by a subject URI

Mangrove doesn't have its own place database, so a review has to point at
something. It does this with a **subject URI** — a stable string that identifies
what is being reviewed. For a place, OpenMapX builds a geographic subject from
the place's coordinates and name, of the form:

```
geo:LAT,LON?q=NAME&u=UNCERTAINTY
```

That is the same convention Mangrove's own interface uses, which is why a review
you write lines up with reviews written elsewhere for the same spot.

Matching reviews to the right place is the genuinely hard part, because two
different cafés can sit within a few meters of each other. OpenMapX queries
Mangrove spatially, then tightens the result locally: a returned review only
attaches to a place when it is close enough *and* shares an identity signal —
the same OpenStreetMap element, or a matching place name — with reviews that have
neither only attaching when the pin sits effectively on top of the place. The
upshot is that the Reviews tab tries hard to show reviews that are really about
*this* place and not its neighbors.

### Writing a review is signed in your browser

Mangrove has no passwords and no accounts in the usual sense. A review is a small
record **cryptographically signed** with a keypair, and your **public key is your
identity** — it's what ties all of your reviews together and lets the app
recognize "your" review on a place. The **private key never leaves your browser**;
it is what signs each review, and it is the one piece you must not lose.

When you write, edit, or delete a review, OpenMapX assembles the review, signs it
locally with your private key, and sends the finished signed record to Mangrove
through your API server. The server only ever forwards an already-signed record —
it cannot author a review on your behalf.

#### Setting up your signing key

Writing requires you to be signed in to OpenMapX, and the first time you write,
a short setup wizard creates your signing key and asks how to protect it. There
are three options:

- **Passphrase (recommended)** — your private key is encrypted with a passphrase
  before it leaves the browser. The server stores only the encrypted blob and can
  never read your key; you re-enter the passphrase to unlock it for signing.
- **Passphrase + passkey** — the same encryption, plus the option to unlock with
  a device passkey (WebAuthn / biometrics) instead of typing the passphrase.
- **Unencrypted** — the key is stored without a passphrase. Convenient, but the
  server can then read your private key, so the wizard flags this clearly and
  asks you to confirm.

In the encrypted modes the unlocked key is held in memory only for the session
and auto-locks after a period of inactivity, so you re-authenticate before
signing again.

:::caution Don't lose your key
Your private key *is* your reviewing identity. If you lose it — and have no
backup — you can no longer edit or delete your existing reviews, and a new key
starts a fresh identity. The encrypted modes also mean that if you forget your
passphrase and have no passkey, the key cannot be recovered. Use the export
option (below) to keep a backup somewhere safe.
:::

### Privacy and portability

A few consequences of this design are worth calling out:

- **Pseudonymous by default** — there is no email or real name attached to a
  review. You're identified by your public key and an optional nickname you
  choose.
- **Your data isn't trapped** — because reviews live in the open Mangrove
  network, they remain readable and usable outside OpenMapX. You can **export**
  your private key from the account settings and import it into Mangrove's own
  site or another OpenMapX instance to keep the same identity and continue
  managing the same reviews.
- **Open license** — Mangrove content is openly licensed, which is what makes
  this federation possible; the Reviews tab credits the source accordingly.

## Enabling and configuring

Reviews work out of the box — there are no API keys to obtain and no service to
build. The two integrations involved, `reviews` and `reviews-mangrove`, are
first-party and built in, and `reviews-mangrove` is enabled by default. With them
enabled, reading reviews needs no configuration at all, since Mangrove's public
API is open.

Writing additionally needs the parts of OpenMapX that hold user accounts and the
encrypted key envelope:

- **Accounts** — users sign in through the app's built-in authentication, which
  is what the signing-key setup is attached to. Reading is fully anonymous;
  only writing, editing, and deleting require an account.
- **Database** — the encrypted key envelope is stored per user in the same
  PostgreSQL database the rest of the app uses, so no extra service is required.

To turn the feature off entirely, disable the `reviews-mangrove` integration from
the admin panel; with no review provider registered, the Reviews tab simply shows
nothing to read and no way to write. For how integrations are enabled, disabled,
and configured, see [Managing services](../install/managing-services.md).

## Attribution and licensing

Reviews displayed in OpenMapX come from the Mangrove dataset and are credited to
[Mangrove.reviews](https://mangrove.reviews/) under its open Creative Commons
license. When you contribute a review you are publishing into that open dataset
under the same terms, so others can build on it — review Mangrove's own
[terms](https://mangrove.reviews/terms) before deploying or contributing.

## Related

- [Places & enrichment](./places.md) — the place panel the Reviews tab lives in.
- [Search](./search.md) — how a place is resolved before you can review it.
- [Street-level imagery](./street-level-imagery.md) — another open-data layer
  surfaced on place panels.
