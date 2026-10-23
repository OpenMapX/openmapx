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

Accounts contain a name, email, verification state, optional avatar, role and
ban state. Authentication uses Better Auth, configured in
`apps/api/src/auth.ts`.

| Role            | Permissions                                        |
| --------------- | -------------------------------------------------- |
| `user`          | Use personal account features                      |
| `privacy_admin` | Handle privacy cases and inspect privacy readiness |
| `admin`         | Manage the deployment, accounts and privacy setup  |

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

The CLI updates roles directly. Keep another working administrator before
using `demote`; browser self/last-admin protections do not protect this recovery
path.

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

Choose **Send Password Reset** from the row menu. The action requests a reset
link by email; the owner sets the replacement password. Configure and test the
email provider first.

### Sessions

The **Sessions** tab lists active sessions, including IP address, user agent
and creation/expiry times. Revoke one session or use **Revoke All Sessions**
when an account may be compromised. Handle session details as personal data.
The saved Session Duration setting is currently not wired into Better Auth;
use the observed expiry and current authentication configuration when assessing
session lifetime.

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

New email/password accounts must verify their address before sign-in. The
runtime sets `requireEmailVerification: true`. Verification and password-reset
links need a working email provider; email changes use the configured email OTP
flow. See [Configuration](../install/configuration.md).

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

Better Auth registers TOTP, backup codes and email OTP support. Users enroll
and manage their factors from account settings. Enrollment is voluntary; the
saved Enable Two-Factor Authentication field does not currently enable, disable
or require enrollment. Verify recovery access before revoking an account's
sessions.

## Where to go next

See [Admin panel](./admin-panel.md) for access boundaries,
[Monitoring](./monitoring.md) for audit and execution logs, and
[User erasure operations](./user-erasure.md) for deletion handling.
