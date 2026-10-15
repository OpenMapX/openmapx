---
"@openmapx/integration-openconditions": minor
"web": patch
---

The OpenConditions integration serves three more domains. Its `weather` feeds
are credited under `road-weather` and read as `weather_station` features with
the readings of the station and each surface sensor; its `vehicles` feeds under
`service-vehicles`, read as `vehicle.position` readings from
`/observations/latest`; and its `border` feeds under `border-crossings`, read as
canonical `border_crossing` features with every agency's queues. A value shows
only while current (an hour for weather values, two hours for waits, a
position until it expires), and every record credits its feed, upstream
publishers and any publisher notice. The legal pages gain the three sections.
