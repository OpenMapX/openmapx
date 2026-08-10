# WebView storage qualification

What the WebView keeps, for how long, and what happens when it loses it.

The reason this matters is narrow and specific. The web UI is served remotely,
so everything the WebView caches is an optimisation — never a guarantee. The
guarantee lives natively: a session that started while online continues through
network loss and through the WebView failing entirely. These checks exist to
confirm that the two are actually separate, and that no cached page is ever
mistaken for navigation authority.

A pass on one WebView build says nothing about another, so record versions.

```
Date:
iOS simulator (version / device):
Android emulator (API level / device):
App version / build:
Web build id (from the handshake):
```

## Ordinary warm storage

- [ ] Load the app online. Confirm the map, search and saved places work.
- [ ] Pan and search, then restart the app while still online. Confirm it loads
      without a visible re-download of the shell.
- [ ] Restart the app with all networking disabled. Record what appears: a
      cached shell, an honest offline message, or a blank page. **Any of these is
      an acceptable result** — the point is to record which, not to force one.
- [ ] Install an updated local Release build over the previous one. Confirm the
      app loads and that no stale shell is served indefinitely.
- [ ] Clear website data through the OS. Confirm the app recovers on next launch
      rather than needing a reinstall.

## What is stored, inspected separately

Each of these is a different mechanism with different eviction behaviour, so
check them one at a time rather than as "storage".

- [ ] **Service worker Cache Storage.** Record which entries exist after a warm
      load.
- [ ] **IndexedDB.** Record the databases present. Confirm there is no browser
      navigation session record while running inside the shell — the shell owns
      the durable session, and a second one would disagree with it after a crash.
- [ ] **Auth cookie.** Confirm a signed-in session persists across an app
      restart, and that the cookie is not readable from native.
- [ ] **OPFS.** Record whether it is used at all and by what.

## Storage pressure

- [ ] Where the platform supports it, create storage pressure and re-launch.
      Confirm the app degrades to an honest offline or loading state and never
      to a partially-rendered UI claiming data it does not have.
- [ ] Confirm an active native session survives the eviction untouched.

## The captured-route offline contract

This is the part that must hold. Run it for ground and for transit.

### Ground

- [ ] Start a deterministic ground session online.
- [ ] Disable all networking.
- [ ] Feed the fixture's maneuver and stop positions.
- [ ] Confirm progress advances, cues are spoken, and the position follows the
      captured route.
- [ ] Confirm a reroute is refused with a clear reason rather than attempted.
- [ ] Kill the WebView renderer. Confirm guidance continues.
- [ ] Return to the app. Confirm the UI rehydrates from a native full snapshot,
      not from anything the browser had cached.

### Transit

- [ ] Start a deterministic transit session online, with captures present.
- [ ] Disable all networking.
- [ ] Confirm the leg, stop countdown and get-off alert all work from the
      capture.
- [ ] Confirm a live refresh and a replan are both refused offline, and that the
      UI says the times are scheduled rather than live.
- [ ] Confirm a leg whose capture was missing degrades to schedule times and
      says so — it must not invent intermediate stops.

### Cold start with nothing cached

- [ ] Force-quit, clear website data, disable networking, and launch with an
      active native session running.
- [ ] Confirm the app shows an honest "cannot load" state rather than a blank
      screen or a stale UI.
- [ ] Confirm the native recovery overlay still offers Retry and End, and that
      End actually stops the session.
- [ ] Re-enable networking and retry. Confirm the page loads, sends a handshake,
      receives a full snapshot, and shows the session at its current revision —
      not at the revision it had when the page died.

## Pending volunteer-beta cases

- [ ] **Real OS suspension.** A simulator does not suspend or terminate an app
      the way a device under memory pressure does, so "survives backgrounding"
      cannot be established here.
- [ ] **Locked-screen alert delivery.** Whether the get-off alert actually wakes
      somebody depends on Focus modes, notification settings, and vendor power
      management that virtual devices do not model.
- [ ] **Vendor battery optimisation.** Several Android OEMs terminate background
      services far more aggressively than AOSP. Only affected hardware shows it.
- [ ] **Long-run cache eviction.** Whether the service-worker cache survives days
      of ordinary phone use is not something a fresh emulator can answer.
