# Volunteer beta evidence

This directory holds sanitized reports from volunteers running the processed
store artifact on real hardware. **It is empty, and that is the correct state**:
no volunteer has run anything, because no store account exists and no build has
been uploaded.

Nothing may be written here that did not come from an actual device run. An
invented report is worse than a missing one — a missing report is visibly
missing, and an invented one closes a gate that was never passed.

## What each report must be

One file per device, validated against
`../../release/release-candidate-report.schema.json`, with `environment.virtual`
set to `false`. The artifact hash must match the **processed** store artifact —
TestFlight and Play both re-sign, so the hash of what a tester installed is not
the hash of what was uploaded. Record the one the tester actually has.

Expected filenames once runs happen:

- `1.0.0-ios.json` — a current-iOS iPhone.
- `1.0.0-pixel.json` — an Android 16 / API 36 Pixel-class device.
- `1.0.0-samsung.json` — a recent Samsung with **default** battery management,
  which is where background services are terminated most aggressively.

## What only these runs can establish

Everything the pre-beta matrix marks `pending-physical`:

- Guidance surviving real OS suspension, over a real trip length.
- Locked-screen alert delivery through Focus and Do Not Disturb modes.
- Spoken-cue latency and audio focus against real Bluetooth and calls.
- Battery drain per hour and thermal behaviour.
- Vendor battery management terminating the foreground service.
- Passkeys on real authenticators, and real identity-provider consent screens.
- Verified App Links and Universal Links against a signed, installed build.

## Sanitisation

Before committing a report: no coordinates, no addresses, no account or email,
no device identifier, no token, and no notification content. A route is
described as "a 40-minute suburban drive", not as a pair of endpoints.
