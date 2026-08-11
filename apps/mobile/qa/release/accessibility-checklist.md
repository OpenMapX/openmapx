# Accessibility checklist

The app is a WebView plus a handful of native overlays, so accessibility is
mostly the website's — with one exception that matters: the native overlays
appear exactly when something has gone wrong, and they are the only thing on
screen. If they are unreachable, the user is stuck with no way out.

Run on both platforms, on the local Release build.

## Screen readers

- [ ] VoiceOver reaches every control in the WebView, in a sensible order.
- [ ] VoiceOver reaches the native loading, error, offline and recovery overlays,
      and their Retry and End actions.
- [ ] TalkBack does the same.
- [ ] The foreground-service notification is announced.
- [ ] Nothing announces raw coordinates or an internal identifier.

## Text and display

- [ ] Dynamic Type at the largest accessibility size: no clipped or overlapping
      text in the native overlays.
- [ ] Browser text zoom at 200%: the web UI reflows.
- [ ] Screen zoom does not trap focus.
- [ ] Bold text is honoured.
- [ ] Reduced motion suppresses the camera's animated transitions.
- [ ] Dark, light and high-contrast modes are all legible.

## Colour and targets

- [ ] Off-route, weak GPS, and degraded-capture states are conveyed by text or
      icon as well as colour.
- [ ] Every interactive target is at least 44 pt (iOS) or 48 dp (Android).

## Input

- [ ] Switch control can operate the native overlays.
- [ ] An external keyboard can reach and activate them.
- [ ] Focus does not escape into the WebView while an overlay is showing.

## Localisation

- [ ] German permission strings fit the OS prompt without truncation.
- [ ] German overlay copy fits at the largest text size.
- [ ] Plurals are correct in both locales.
- [ ] RTL layout does not corrupt the overlays, even though no RTL locale ships.

## What this checklist does not authorise

Passing it does **not** justify claiming an App Store Accessibility Nutrition
Label category. Those have their own published criteria and must be assessed
against them directly.
