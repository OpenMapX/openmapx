# Accessibility checklist

Run on both platforms against the identified local Release build and web build.
Test the WebView and native overlays separately, including loading/error states
where the overlay may be the only usable UI. Record actual results; this file
contains no completed acceptance evidence. Navigation/notification cases require
the foreground composition currently missing from `src/App.tsx`.

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
- [ ] Every interactive target meets the project targets of 44 pt (iOS) or 48 dp
      (Android).

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
