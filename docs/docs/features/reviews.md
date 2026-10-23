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

### Writing a review is signed in your browser

The browser signs each write, edit, or deletion with your private key. OpenMapX
forwards the signed record. The public key identifies the author and connects
reviews made under that identity, even when the nickname changes.

#### Setting up your signing key

The setup wizard can create a key or import a compatible existing private JWK.
Choose how it is stored:

| Mode                 | Protection and recovery                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| Passphrase           | The browser encrypts the key before uploading it; unlock with that passphrase                  |
| Passphrase + passkey | Adds a supported device credential as another unlock method; retain the passphrase as recovery |
| Unencrypted          | The server stores a readable private key; setup requires an explicit confirmation              |

In encrypted modes, the unlocked private key stays in browser memory and locks
after 15 minutes without a key operation. Signing out clears the session key.
The review-key passphrase is separate from your OpenMapX sign-in password.

:::caution[Keep a recovery copy]
Losing the key and every working unlock method prevents you from editing or
deleting reviews under that identity. Resetting your OpenMapX password cannot
recover it. Creating a new key creates a different reviewing identity.
:::

### Privacy and portability

Under **Account settings**, find the Mangrove signing-key section. Unlock the
key and choose its export action to download or copy the private JWK. Store that
file privately: anyone who obtains it can act as your review identity. The
export is compatible with supported Mangrove clients and another OpenMapX
instance's import flow. It is not included in a normal data-access archive.

Encrypted modes protect the stored key from a database-only disclosure. They
cannot protect an unlocked key from malicious code served by a compromised
OpenMapX application. Passkeys for this key do not encrypt saved places or other
account content. See the [user-data trust model](../developer/user-data-trust-model.md).

## Enabling and configuring

The built-in `reviews` and `reviews-mangrove` integrations need no Mangrove API
key. `reviews-mangrove` is enabled by default. Writing also needs working account
and database services for the key envelope. Operators manage provider enablement
under [Admin → Integrations](../administration/integrations-administration.md).
Disabling the provider prevents normal review retrieval and submission through it;
it does not delete published reviews or stored keys.

## Attribution and licensing

The Mangrove integration declares CC BY 4.0 for review content and displays its
source credit. Contributions are published to the external dataset. Review the
linked [Mangrove terms](https://mangrove.reviews/terms) before contributing or
operating the integration.

## Related

- [Places](./places.md): the panel containing Reviews.
- [Accounts and your data](./accounts-and-privacy.md): data copies and account deletion.
- [OpenStreetMap contributions](./osm-contributions.md): correct map facts rather than reviewing them.
