---
impacts: [security]
---

## What changes

Changing an account's email address, adding or removing a passkey, connecting a
new sign-in provider, disconnecting one and deleting the account now need a
sign-in from the last ten minutes. When the account has two-factor
authentication, that sign-in must include the password and the second factor.
If the last sign-in is older, the web app asks the person to sign in again and
then repeat the change.

Account deletion no longer asks for the password in account settings; the recent
sign-in is the confirmation for every kind of account, including passkey-only
and OpenStreetMap or Mapillary accounts.

After an email change, the previous address receives a short notice that the
address was changed. Provider placeholder addresses receive nothing.

Administrator impersonation sessions can no longer change the target account's
email, passkeys, linked providers, password or second factor, or delete it. An
account can hold only one identity per sign-in provider.

## Who is affected

Every installation. People changing these settings in a session older than ten
minutes sign in once more. Custom clients that call these Better Auth endpoints
receive `401` with code `FRESH_SIGN_IN_REQUIRED`, or `403` with code
`IMPERSONATION_NOT_ALLOWED`. Adding more OpenStreetMap permissions for
contributions to an already connected account is unchanged.

## Required action

None. Update as usual. The notice uses the configured email provider.
