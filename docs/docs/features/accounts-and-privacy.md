---
title: Accounts and your data
description: Manage sign-in, request a copy of your data, and understand account deletion.
---

# Accounts and your data

An OpenMapX account belongs to the instance where you create it. It lets you
synchronize saved places, vehicles, and parking, connect a personal timeline,
and manage a review signing key. You can browse the map without an account.

Open the account control and choose **Sign in** or **Create account**. Complete
any email verification requested by the instance. External sign-in providers
appear only when the operator has configured them; using one redirects your
browser to that provider.

If verification or password-reset mail does not arrive, check spam folders and
contact the instance operator. Account support and email delivery are managed by
that instance.

## Manage sign-in and recovery

Open your account menu and choose **Account settings**. Depending on your
account's sign-in methods, you can change your name, email, and password, manage
linked providers, add passkeys, and set up two-factor authentication.

When enabling two-factor authentication, complete the authenticator verification
and store the backup codes somewhere safe. Passkeys depend on your browser,
device, and credential provider. Keep a working recovery method before removing
an existing sign-in method.

Account authentication and review-key protection are separate. Resetting your
OpenMapX password does not recover a forgotten Mangrove signing-key passphrase.
See [Reviews](./reviews.md) for key export and recovery limits.

## Request a copy of your data

1. In **Account settings**, find **Your data and access request**.
2. Choose **Request data copy**. The request appears with its current status
   and response deadline.
3. Return to the section to check progress. A request can require an identity
   check, a connected processor, clarification, or manual operator review.
4. When an archive is ready, choose **Download archive** and complete the fresh
   sign-in requested before download.

The request covers controller-held data and connected sources according to the
instance's collection and review process. Check the archive's completeness and
source information; an unavailable connected source is not proof that it holds
no data. Secret material, such as passwords and private signing keys, is excluded.
Use a feature's dedicated credential-backup process when needed.

The available actions depend on request state. **Withdraw request** stops an
active request, **Delete archive** revokes an existing artifact, and
**Create fresh copy** requests a new collection where offered. Archives expire;
use the displayed state to decide whether to request another copy.

**Download browser data** is a separate local export. It covers the supported
data held by this browser, not every device, the server database, or arbitrary
browser storage. Keep downloaded archives private: they can contain personal
locations and account information.

If the privacy team supplies a case reference for an assisted request, use
**Link an assisted request** and complete the requested account sign-in. Contact
the operator through the instance's privacy details if the request needs help.

## Delete your account

Before deleting the account:

- Download any data and saved-place lists you want to keep.
- Delete Mangrove reviews you want removed while you still control the signing
  key, or export the key so you can manage those public reviews later.
- Handle a connected Dawarich account and its location history directly with
  Dawarich. Deleting the OpenMapX connection does not delete that source account.

In **Account settings → Danger zone**, choose **Delete account**, read the
warning, and complete the password or verification flow. Deletion removes the
OpenMapX account and its associated sign-in data, saved content, shares,
vehicles, parking, timeline connection, settings, and review signing key.
The operation cannot be undone through OpenMapX. Privacy-case records can be
retained under the instance's request-handling and retention process; account
deletion does not necessarily close an active request. Contact the operator if
one is still pending.

After the server confirms deletion, the app attempts to clear this browser's
query data, offline packages, caches, and local storage. Check site storage on a
shared device if cleanup fails. Files already downloaded outside the app and
data on other devices require separate removal.

Public OpenStreetMap contributions and Mangrove reviews are held by those
services and remain subject to their processes. Existing backups can retain
deleted OpenMapX data until the operator's retention period expires; live
account deletion does not rewrite those snapshots.

## Who can read synchronized data

Ordinary account content is stored on the instance's server and is not
end-to-end encrypted. The server and an operator with database access can read
it. Server-held credential encryption, encrypted review-key modes, and passkey
authentication protect different things; they do not encrypt all account content.

Read the instance's privacy page for its operator, sources, retention, and
contact information. The [user-data trust model](../developer/user-data-trust-model.md)
describes the implementation boundary. Operators should follow
[Data-subject requests](../administration/data-subject-requests.md) and
[User erasure](../administration/user-erasure.md).
