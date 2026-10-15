---
"@openmapx/mobility-core": minor
"@openmapx/integration-framework": minor
"@openmapx/integration-openconditions": minor
---

Follow OpenConditions' station status, sanding and vehicle trail changes. A road
weather station's `device.status` sets its state: `offline` is out of service,
`warning` and `error` a suspected or confirmed `fault` beside its values, judged
by the status's validity rather than its age. A service vehicle's `sanding`
activity is read, and its `trail` (where it has been in its current task over
the last ten minutes) is carried. A vehicle's position id changes as it reports
again, so a reopened vehicle is followed to its next position: the one standing
where it stood or whose trail passes there.
