---
title: Users & access
description: Accounts, the admin role, sessions, impersonation, banning, and the sign-in methods OpenMapX supports.
sidebar_position: 5
---

# Users & access

OpenMapX has accounts. Most of the map works without one — search, directions,
and transit don't require a login — but signing in unlocks per-user features
like saved places and writing reviews, and it's how you reach the admin panel.
This page covers the user model, how someone becomes an admin, the day-to-day
moderation tools, and the authentication methods you can offer.

Authentication is built on [Better Auth](https://www.better-auth.com/). The
configuration lives in `apps/api/src/auth.ts`, and most of what an operator
tunes is exposed in **Settings → Authentication** in the admin panel rather than
edited there directly.

## The user model

Every account has a small, fixed set of fields: a name, an email, a verified
flag, an optional avatar, a **role**, and moderation state (banned, ban reason,
ban expiry). The three roles are:

- **`user`** — the default. Can use the app and manage their own account, but
  never sees `/admin`.
- **`admin`** — everything a user can do, plus the full operations surface.
  This role manages instance configuration and accounts.
- **`privacy_admin`** — access to the dedicated privacy case workflow; it does
  not grant general instance or account administration.

The role is the single gate in front of the [admin panel](./admin-panel.md). In
the browser the `/admin` route checks it before rendering, and on the API every
admin endpoint re-verifies the session and role server-side, so the role is what
actually grants access — not just what hides a menu item.

## Becoming an admin

A fresh instance has no admins. You promote the first one from the host's
command line, and every admin after that can be made from the UI.

### The first admin

After deploying, register a normal account through the web app, then promote it
from a shell on the API host with the `openmapx` CLI:

```bash
pnpm openmapx users promote your@email.com
```

The command shells into the `postgis` container and flips the account's role to
`admin`. Sign out and back in, and the admin center appears in your account
menu.

One wrinkle on a brand-new deployment: Better Auth blocks sign-in until an email
is verified, and if you haven't configured an email provider yet, no
verification mail is ever sent — so the first user can't sign in to configure
email in the first place. Break the deadlock by marking the address verified
directly:

```bash
pnpm openmapx users verify your@email.com
```

Then sign in, set up an email provider under **Settings → Email**, send the test
message, and self-service signup verifies normally for everyone after you.

The same command family rounds out CLI user management:

```bash
pnpm openmapx users list             # id, email, name, role
pnpm openmapx users demote your@email.com   # back to a plain user
```

These all run against the database in the `postgis` container, so they work even
when the web app is down — which is exactly when you tend to need them.

:::note[Why the CLI works without logging in]

These bootstrap user commands run through the host's generated Compose
configuration and database container. Protect host access. Other CLI operations
can use the local admin API escape hatch described in
[Admin panel](./admin-panel.md); that path cannot substitute for the fresh
account-session confirmation required by assisted recovery.

:::

### Promoting and demoting from the UI

Once you have one admin, the rest is point-and-click in **Users**. Change a
person's role inline from the user list, or open their detail page and set it in
the **Profile** tab. To stop someone being an admin, set their role back to
**User**.

Two guardrails keep you from locking yourself out: you can't change your own
role, and the last remaining admin can't be demoted or deleted.

## Managing users

The **Users** section of the admin panel lists every account, with search by
email and quick filters for **All / Active / Banned / Admins**. Each row shows
the role, verification and ban status, and whether two-factor is on. Open a user
to reach three tabs — **Profile**, **Sessions**, and **Accounts** — or act
straight from the row's menu. The actions available:

### Create a user

**Create User** makes an account directly — name, email, a password (minimum
eight characters), and a starting role. Leave **Send welcome email** checked to
notify the new user, or uncheck it to create the account silently. This is the
way to onboard someone without making them go through self-service signup.

### Edit a profile

The **Profile** tab edits a user's display name and role. Email is read-only
from the admin side: an address change has to come from the user themselves
(it's verified with a one-time code), so you can't silently move an account to a
new mailbox. The same tab surfaces read-only facts — account ID, created and
updated timestamps, verification and two-factor state, and any ban reason.

### Reset a password

Open **Users → Create User** to provision an account. You may supply an initial
password or leave it empty to send a one-use setup link. The welcome checkbox
requests separate verification and password-setup emails; setup is required if
no initial password was supplied. Passwords are never included in the message.
Creating or resetting an account does not mark its email verified.

The created account remains visible if mail fails. **Latest administrative mail
request** distinguishes queued, accepted by the mail service, failed and unknown
handoffs. Acceptance does not prove delivery. Interrupted sends remain unknown
and are never automatically resent; check with the recipient before making an
explicit new request. Use **View account and recovery actions** rather than
creating the same account again.

Open **Account recovery** from a user's row or profile for an invitation,
verification email, password-reset link, assisted verification or temporary
password. Review the selected account, confirm the action, and complete a fresh
administrator sign-in with its configured second factor. After returning from
sign-in, reopen the original action and review it before confirming. Passwords
are deliberately not carried across that navigation. Assisted verification
requires the current email and a recorded reason; use it only after verifying
identity outside this flow. Password replacement revokes existing sessions and
reset links while preserving the verification flag. Mail actions are limited
to three per target and twenty per administrator per hour.

Setup links expire, are one-use, and are replaced by an explicit new setup
invitation. A separate verification email proves ownership of the email address.
A working email provider is required for both; see **Settings → Email**.

### Sessions

The **Sessions** tab lists a user's active sessions with their IP address, user
agent, and creation and expiry times. **Revoke** ends one session; **Revoke All
Sessions** signs the user out everywhere at once. Reach for this when an account
may be compromised, or to force a re-login after a role or password change.

New sessions have an absolute lifetime set by **Settings → Authentication
policy** — seven days by default. Activity does not extend that deadline.
Existing sessions keep their original expiry after a policy change.

### Ban and unban

**Ban** immediately prevents an account from signing in; existing sessions stop
working too. You can record an optional reason, which shows on the user's row
and detail page. **Unban** reverses it at any time. Banning is reversible and
preserves the account and its data, which makes it the right tool for
suspending access — as opposed to deleting, which is permanent. You can't ban
yourself.

### Impersonate

**Impersonate** opens the app as that user, so you can reproduce what they see —
useful for support and for debugging a problem you can't reproduce from your own
account. You can't impersonate yourself, and you return to your own session when
you stop impersonating.

### Delete

**Delete** permanently removes the account and its data, and can't be undone.
The last admin and your own account are protected from deletion; for everything
else, prefer **Ban** unless you genuinely need the account gone.

:::note[Every action is logged]

State-changing user actions — role changes, bans, deletions, session revokes —
are written to the audit log with who did it and to whom. Review them under
**Activity**; see [Monitoring](./monitoring.md).

:::

## Authentication methods

OpenMapX supports several ways to sign in. Which ones are offered depends on
what you've configured; the sign-in dialog only shows methods that are actually
set up.

### Email and password

The default. New users register with an email and password, and — when
verification is required — confirm their address before they can sign in.
Password reset runs over a one-time code sent by email, and so does changing an
account's email. Whether verification is enforced and the minimum password
length are set under **Settings → Authentication policy**.

This path depends on a configured email provider for verification and reset
messages. See **Settings → Email** and
[Configuration](../install/configuration.md).

### Passkeys

OpenMapX supports passkeys (WebAuthn) for passwordless sign-in. Users add a
passkey from their own account settings and can then sign in with **Sign in with
a passkey** — no password prompt. Passkeys need two environment variables to
match your deployment's domain: `PASSKEY_RP_ID` (your hostname, e.g.
`maps.example.com`) and `PASSKEY_ORIGIN` (the full origin, e.g.
`https://maps.example.com`). They default to `localhost`, which only works in
local development.

### OAuth / OIDC providers

Users can sign in with an external identity provider, and link it to an existing
account. Two providers are built in:

- **OpenStreetMap** — OpenID Connect, discovery-based, with PKCE.
- **Mapillary** — a custom token exchange.

Each provider only appears in the sign-in dialog once its client credentials are
present in the environment (`OSM_CLIENT_ID` / `OSM_CLIENT_SECRET`,
`MAPILLARY_CLIENT_ID` / `MAPILLARY_CLIENT_SECRET`), and each provider's
application must list `https://<DOMAIN>/api/auth/callback/<provider>` as its
redirect URL (see
[Redirect URLs](../install/configuration.md#redirect-urls)). Linking lets a user connect
these to an email account and pull in a profile picture; they manage their
linked accounts from their own account settings, not from the admin panel.

### Two-factor authentication

When new enrollment is allowed under **Settings → Authentication policy**, users can add a second factor
to their account: a TOTP authenticator app, with backup codes for recovery.
Email one-time codes are also available. Two-factor is opt-in per user — the
setting controls whether anyone can enroll, not a blanket requirement — and the
user list flags accounts that have it turned on.

## Effective authentication policy

The policy panel shows the active values, their ownership source, activation
version and revision. Before explicit version-1 activation, safe defaults stay
active: email verification required, 168-hour sessions, new 2FA enrollment
allowed and an eight-character password minimum. Existing legacy settings are
shown as a separate draft. Loading that draft only edits the form; **Activate
authentication policy** applies all four reviewed values atomically.

Session lifetime accepts 1–8760 whole hours and password minimum accepts 8–128
characters. Passwords have a maximum of 128 characters. Turning off new 2FA
enrollment leaves existing second factors and sign-in challenges in place.
`AUTH_EMAIL_VERIFICATION`, when active, owns the verification setting and locks
that field in the panel. A conflicting or failed apply preserves the active
policy; reload before retrying a changed revision.

## Where to go next

- **[Admin panel](./admin-panel.md)** — how `/admin` is gated and the loopback
  escape hatch the CLI uses.
- **[Monitoring](./monitoring.md)** — the audit log of admin actions.
- **[Configuration](../install/configuration.md)** — the settings cascade and
  the environment variables referenced above.
