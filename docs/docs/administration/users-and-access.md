---
title: Users & access
description: Create the first administrator, assign roles, manage sessions and understand authentication limits.
sidebar_position: 5
---

# Users & access

Search, directions and transit work without an account. Signing in enables
personal features such as saved places and reviews. Administrators also gain
access to operations or privacy casework according to their role.

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

Authentication uses Better Auth, configured in `apps/api/src/auth.ts`.

The API enforces roles independently of the browser layout. Privacy casework
has additional identity, authentication-assurance and review requirements;
see [Data-subject requests](./data-subject-requests.md).

## Becoming an admin

### The first admin

You need a shell in the deployment checkout, Docker access and a running
`postgis` service with the generated Compose configuration.

1. Register a normal account through the web app. The first account is not
   promoted automatically.
2. Promote the exact email address from the repository root:

   ```bash
   pnpm openmapx users promote your@email.com
   ```

3. If email delivery is not configured and verification prevents sign-in,
   verify that account locally:

   ```bash
   pnpm openmapx users verify your@email.com
   ```

4. Sign in again. Open `/admin`, configure **Settings → Email**, and send a
   test message before relying on self-service verification or recovery.

These commands execute SQL through the `postgis` container; they work while the
web app or API is down. They require an existing account and report an error if
no email matches. They do not acquire a session or use loopback HTTP admission.

```bash
pnpm openmapx users list
pnpm openmapx users demote your@email.com
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

Keep another working administrator before using `demote`: browser self/last-admin
protections do not protect the host recovery commands.

### Promoting and demoting from the UI

Open **Users**, then change the role in the list or the user's **Profile** tab.
The list disables self-role changes and protects the last full administrator.
Treat those controls as browser safeguards, not a guarantee for direct database
or every authentication API operation.

Select **Privacy admin** to grant casework access without general deployment
permissions. Granting or revoking this role uses a dedicated full-admin endpoint
and revokes the target's existing sessions. The person must sign in again.
That endpoint cannot downgrade a full administrator; change a full-admin role
through the ordinary account administration flow.

## Managing users

Search by email and filter **All**, **Active**, **Banned** or **Admins**. Open an
account for **Profile**, **Sessions** and **Accounts** tabs. Check the exact
account identity before acting.

### Create a user

Use **Create User** and enter the name, email, password and starting role. The
form requires at least eight password characters. Its Send welcome email
checkbox forwards a flag, but the current API has no sender that consumes it.
Arrange onboarding separately and verify recovery-email delivery; creating an
account does not notify the recipient by itself.

### Edit a profile

Change the display name and role on **Profile**. The administrator form keeps
email read-only. The account owner changes their address through the verified
email-change flow. Account ID, timestamps, verification, two-factor state and
ban reason help distinguish accounts with similar names.

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

Handle session IP addresses and user-agent details as personal data.

### Ban and unban

**Ban** suspends sign-in and invalidates existing access through Better Auth's
ban handling. Record a reason if needed. **Unban** restores eligibility to sign
in. Banning preserves account data and can be reversed. The list prevents
self-banning.

### Impersonate

Use **Impersonate** only for authorized support work: it creates access as the
target user and can expose their personal data. Stop impersonation to return
to your administrator session. The list prevents impersonating yourself.

### Delete

Deletion removes live account-owned data and invokes the erasure workflow. It
cannot retract public Mangrove reviews, delete a separate Dawarich account or
rewrite existing backups. Active privacy cases can retain minimized encrypted
material under their own retention rules. Follow [User erasure
operations](./user-erasure.md) for the journal, external systems and verification.

The user list protects self-deletion and the last administrator. Verify that
another administrator can sign in before removing administrative accounts.
Audit records capture supported account actions; audit insertion failures are
logged but generally do not block the action. See [Monitoring](./monitoring.md).

## Authentication methods

The current runtime configuration enables email/password with email verification,
passkeys, the configured OAuth providers, TOTP/backup codes and email OTP
support. The saved Authentication settings are not read by `auth.ts`: changing
Require Email Verification, Session Duration, Enable Two-Factor Authentication
or Minimum Password Length does not currently change Better Auth enforcement.

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

Users enroll passkeys in account settings. Configure the relying-party hostname
with `PASSKEY_RP_ID`, for example `maps.example.com`, and accepted origins with
`PASSKEY_ORIGIN`, for example `https://maps.example.com`. The latter accepts a
comma-separated list. Defaults are `localhost` and `http://localhost:3000` for
development. Use HTTPS and origins matching the real deployment.

### OAuth / OIDC providers

The built-in providers are OpenStreetMap (OIDC with PKCE) and Mapillary (custom
token exchange). Configure their client IDs and secrets:
`OSM_CLIENT_ID` / `OSM_CLIENT_SECRET` and
`MAPILLARY_CLIENT_ID` / `MAPILLARY_CLIENT_SECRET`.

Register `https://<DOMAIN>/api/auth/callback/<provider>` with the provider.
The OpenStreetMap provider ID is `openstreetmap`; Mapillary uses `mapillary`.
See [Redirect URLs](../install/configuration.md#redirect-urls).
Users manage linked accounts from their own account settings.

### Two-factor authentication

When new enrollment is allowed under **Settings → Authentication policy**, users can add a second factor
to their account: a TOTP authenticator app, with backup codes for recovery.
Email one-time codes are also available. Two-factor is opt-in per user — the
setting controls whether anyone can enroll, not a blanket requirement — and the
user list flags accounts that have it turned on.

Verify recovery access before revoking an account's sessions.

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

See [Admin panel](./admin-panel.md) for access boundaries,
[Monitoring](./monitoring.md) for audit and execution logs, and
[User erasure operations](./user-erasure.md) for deletion handling.
