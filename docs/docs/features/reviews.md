---
title: Reviews
description: Read Mangrove reviews, publish your own, and back up your review signing key.
sidebar_position: 10
---

# Reviews

Open a [place panel](./places.md) and choose **Reviews** to read available
ratings, opinions, and photos from Mangrove. Reading requires no OpenMapX
account. Writing requires sign-in and a review signing key.

Reviews are public contributions to Mangrove. Deleting your OpenMapX account
does not delete those reviews. Keep your key if you want to manage them later.

## What you get

The tab shows an aggregate rating and individual reviews, newest first, when
available. A review can include a nickname and photos. Your public key identifies
your reviews; after you review a place, the write action becomes an edit action.
Links to other review platforms can appear where the place has suitable references.

To contribute:

1. Sign in, open the place's **Reviews** tab, and choose **Write a review**.
2. Set up or unlock your signing key when prompted.
3. Add a rating, opinion, and any photos, then submit.
4. Use the controls on your review to edit or delete it later.

Avoid personal or confidential information in a public review or photograph.
The image relay accepts JPEG, PNG, WebP, and GIF files up to 5 MiB each.

## How it works

### Reviews come from Mangrove

Mangrove is the external review store. OpenMapX retrieves and caches reviews
through its server and relays signed submissions to the provider. A temporarily
unavailable source can leave the tab empty or show an error; an empty result
does not establish that no other platform has reviews.

### A place is addressed by a subject URI

A Mangrove geographic subject identifies the place using coordinates and a name:

```text
geo:LAT,LON?q=NAME&u=UNCERTAINTY
```

OpenMapX checks proximity and identity evidence, such as a matching name or OSM
reference, before attaching a review to a place. Source differences can still
cause missing or incorrectly matched reviews. Check the place before posting.

### Connect to Mangrove

Choose **Connect to Mangrove** before writing a review. Continue with a passkey,
OpenStreetMap, or Bluesky. This authorization is separate from your OpenMapX
sign-in. Mangrove keeps a signing key for that account and signs your reviews on
your behalf. The same signer account uses the same key across participating apps
and devices. Signing in with OSM does not automatically import a key another app
stored in OSM preferences.

OpenMapX checks the returned signature, key and review content, then relays the
signed review through its server. A public key identifies your reviews and controls
editing and deletion. An optional decentralized identifier from the signer is
account metadata; OpenMapX does not use it to grant authority over another key.

A signer session stays in this browser tab's session storage, bound to your exact
OpenMapX sign-in session. Same-origin scripts can access it. Disconnecting or signing
out removes it locally and attempts remote revocation; revocation can fail during
an outage. The public signer normally expires sessions after 24 hours. Reconnect
when prompted. OpenMapX never silently switches an expired login to a new local key.
If reconnecting while composing, a temporary draft is kept in tab session storage
for up to one hour and restored when you reopen the same review. Publishing consent
must be confirmed again.

Use **Manage Mangrove account** for the signer's passkeys, recovery and identity
settings. The public signer restricts those operations to its own account interface.

### Advanced: encrypted local signing

Choose **Advanced: use an encrypted local key** to keep signing in your browser.
Create a key or import a compatible private JWK, then protect it with a passphrase
or a passphrase plus a supported WebAuthn PRF passkey. The browser encrypts the key
before uploading it. OpenMapX stores ciphertext and public-key/unlock metadata;
plaintext private-key storage is not supported.

An encrypted key supports at most 32 unlock methods. It locks after 15 minutes
without a validated key operation. Signing out clears the session key. Your review
passphrase is separate from your OpenMapX password. Concurrent changes to the same
key are rejected; refresh and unlock again before retrying.

Under **Account settings**, choose the local key's export action to download or
copy its private JWK. Anyone holding that file can sign as that identity. Keep it
private. Compatible clients and other OpenMapX instances can import it. The key is
not included in a normal data-access archive. Losing every unlock method and the
backup prevents future edits/deletions under that key; resetting your OpenMapX
password cannot recover it.

Client encryption protects against database-only disclosure. It cannot protect an
unlocked key from malicious application code. Shared signing instead trusts the
Mangrove signer to protect and use its key correctly. Neither model encrypts
published reviews. See the [user-data trust model](../developer/user-data-trust-model.md).

## Enabling and configuring

The `reviews` and `reviews-mangrove` integrations need no API key for reading or
publishing signed reviews. Writing requires an authenticated OpenMapX session.
Shared signing additionally requires a registered public client identifier:

1. Register your app and exact callback URL with Mangrove, following its
   [login guide](https://open-reviews.net/technology/login/).
2. In **Admin → Integrations → Mangrove.reviews**, configure `signerClientId` and
   `signerRedirectUri`. The callback is `https://YOUR-INSTANCE/auth/mangrove`.
   HTTP is allowed only for loopback development; include that exact URI in the
   upstream registration too.
3. Keep the Mangrove signer source allowed by the instance's data-use policy.
   Shared signing needs the host's distributed request-admission runtime.

The signer origin is fixed to `https://signer.mangrove.reviews`; an unregistered
instance shows an unavailable message and offers encrypted local signing. Running
a different signer is outside this integration's current configuration contract.
Disabling the provider prevents normal review retrieval/submission through it; it
does not delete published reviews. Disabling signer acquisition also prevents login
and signing but does not erase a remote account or guarantee session revocation.

## Attribution and licensing

The Mangrove integration declares CC BY 4.0 for review content and displays its
source credit. Contributions are published to the external dataset. Review the
linked [Mangrove terms](https://mangrove.reviews/terms) before contributing or
operating the integration.

## Related

- [Places](./places.md): the panel containing Reviews.
- [Accounts and your data](./accounts-and-privacy.md): data copies and account deletion.
- [OpenStreetMap contributions](./osm-contributions.md): correct map facts rather than reviewing them.
