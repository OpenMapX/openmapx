---
title: Platform evidence investigation
description: Evidence and limits behind the German train platform corrections.
---

# German passenger platform investigation, 6 November 2026

The reported RE1 (National Express 026839, Aachen 21:51 toward Hamm) had seven
missing platform fields between Aachen and Köln Hbf. Horrem `37` and
Köln-Ehrenfeld `78` were present in both the original DELFI GTFS and the raw
Transitous response: they were upstream values, not concatenation by OpenMapX.

The public Rhein-Ruhr SIRI ET delivery independently supplied
`2, 2, 2, 3, 1, 3, 3, 3, 5 A-C` for the first nine departures. Its train number,
service day, all 27 ordered station roots and all 50 supplied aimed event times
matched the complete MOTIS train. The record timestamp was **18:30:58.165 UTC**,
older than the fetch at 21:19 UTC, with no expected event times. These are
published assignments/corrections, not proof of fresh realtime information.
The committed MOTIS/SIRI fixtures retain the relevant original records and
explain the synthetic SIRI wrapper timestamp.

DB InfraGO NeTEx gave passenger track 3 for the exact Ehrenfeld DHID, but Horrem's
DELFI DHID did not identify the corresponding rail platform. Therefore no NeTEx
name matching, ID arithmetic or generic high-number filtering is applied. The
five exact known bad DELFI station/code pairs are quarantined; all other values,
including a different realtime track at those stations, pass through.

## Open-source comparison

Source inspected at pinned revisions, without qualifying their live endpoints:

- KDE KPublicTransport's [DB parser](https://github.com/KDE/kpublictransport/blob/18512770d387a922fb6fb14f2e396b1e82740f7e/src/lib/backends/deutschebahnparser.cpp#L226-L250)
  reads scheduled `gleis` and expected `ezGleis`. Its
  [MOTIS parser](https://github.com/KDE/kpublictransport/blob/18512770d387a922fb6fb14f2e396b1e82740f7e/src/lib/backends/motis2parser.cpp#L190-L220)
  copies tracks directly and would retain 37/78. Its fill-only merging does not
  correct a conflicting nonempty platform.
- KDE Itinerary's [timeline](https://github.com/KDE/itinerary/blob/1ddcd5cf6f68206609a1f8dee16f7679c995b84b/src/app/JourneySectionStopDelegate.qml#L151-L180)
  uses the effective platform for both its label and map arguments.
- Öffi NG's [DB-Web parser](https://github.com/santawho/public-transport-enabler/blob/4d90de4ab76c0dd6fcb98f30ae8dacfa5209aae6/src/de/schildbach/pte/provider/db/DbWebProvider.java#L547-L581)
  separates planned and predicted passenger fields. PTE's
  [Stop accessors](https://github.com/schildbach/public-transport-enabler/blob/74ca2f7c6bb6116b9bdfb90af5012faba8851d02/src/de/schildbach/pte/dto/Stop.java#L144-L154)
  retain arrival/departure positions independently.

- FossBahn's [realtime merge](https://github.com/T-vK/FossBahn/blob/18b5752670a148512967c3a3e82e4650dd39ccaf/core/model/src/main/kotlin/de/openbahn/model/JourneyRealtime.kt#L59-L82)
  updates platforms without requiring a delay. Its
  [detector](https://github.com/T-vK/FossBahn/blob/18b5752670a148512967c3a3e82e4650dd39ccaf/app/src/main/kotlin/de/openbahn/navigator/tracking/PlatformChangeDetector.kt#L14-L45)
  ignores first assignment and case-only differences. Its approximate board
  matcher is insufficient for overwriting a selected OpenMapX train.
- travelynx's [DBRIS helper](https://github.com/derf/travelynx/blob/64b7a20d9a27b6ee97f1144495a694a3be924234/lib/Travelynx/Helper/DBRIS.pm#L196-L205)
  queries the source's own trip identity; the underlying
  [location mapper](https://github.com/derf/Travel-Status-DE-DBRIS/blob/d4e3646d8774c8eceb9586c5f773b94658975cb3/lib/Travel/Status/DE/DBRIS/Location.pm#L39-L44)
  retains scheduled and realtime tracks separately.

The adopted patterns are explicit passenger fields, event-specific evidence,
sector preservation, one effective selector and strict selected-train binding.
Switching to another app's MOTIS adapter would not repair the source data.

## Acquisition and licensing evidence

[GovData's official catalogue](https://www.govdata.de/suche/daten/delfi-realtime-siri-et-rhein-ruhr)
identifies the dataset as CC-BY-SA 4.0. The
[community mirror licence](https://stc.traines.eu/mirror/german-delfi-siri/LICENSE.txt)
says CC-BY-SA without a version; no separate mirror service-use agreement was
verified. The integration consequently ships **disabled by default** and
preserves supplier attribution when enabled.

A header capture of the fixed mirror URL on 6 November returned XML, 26,391,567
bytes, ETag `"6aee5616-192b40f"`, Last-Modified `22:35:02 GMT`, no content encoding,
and a ServiceDelivery timestamp of `22:33:01.220Z`. The implementation uses
conditional requests, bounded streaming, quotas and compact shared caching.
This is header/fixture evidence; full regional production ingestion, overnight
service-day conventions and native-device behavior remain unqualified.
