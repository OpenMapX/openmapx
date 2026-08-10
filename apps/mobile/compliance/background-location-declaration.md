<!-- Generated from data-practices.json by store-answers.mts. Do not edit by hand:
     change the registry and regenerate, so the policy, the labels and the code
     keep saying the same thing. -->

# Background location declaration

The same words must appear in the OS purpose string, the in-app disclosure, the
privacy policy, the store description, the console declaration, and the review
notes. A reviewer comparing any two of them should find them saying the same
thing — which is the reason this file is generated rather than written six times.

## What the app does

Continuing the same guidance when the user puts the phone in a pocket or the screen turns off, which is the ordinary way people navigate. Only ever active during a navigation session the user explicitly started.

## When it is active

Only while a navigation session the user explicitly started is running. Starting
navigation is a deliberate action: the user plans a route and taps Start. Ending
navigation, or arriving, stops it.

## What the user is told, before the OS prompt

That the app needs location **in the background**, or **when the app is not in
use**, so it can keep guiding them on a route they started while the screen is
locked or the app is minimised; that the guidance is computed on the device;
that coordinates leave the device only to compute a route or a reroute; and that
they can choose foreground-only or end navigation at any time.

## Retention

Identical to the foreground case; background is a delivery mode, not a different practice.

## What it is never used for

Advertising, analytics, profiling, location history, or any transmission that is
not a route the user asked for. The app ships no analytics SDK and no crash
reporter.

## Demonstrating it for review

Record a short video that shows: planning a route, the disclosure screen, the OS
prompt, guidance running, the screen locking, guidance continuing audibly, and
the trip being ended. Use a synthetic or public route — never a real home or
work address.
