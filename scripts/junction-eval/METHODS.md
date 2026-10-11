# Photo registration method comparison

Development characterization, 11 October 2026. These are synthetic public
controls across Germany, not a user's itinerary. Source photographs, raw
responses, predictions and scripts are retained in the external QA package;
none is independently annotated held-out truth.

## Current bounded marking and pose method

The browser replay uses actual React components, reset CSS, browser canvas
decoding and the production module worker. It contains 117 approaches and 39
photographs: 22 prepared, 17 withheld, zero accepted overlays.

| Registration result     | Photographs |
| ----------------------- | ----------- |
| Insufficient boundaries | 20          |
| Off approach            | 9           |
| Unclear scene           | 7           |
| Wrong level             | 1           |
| Unknown layout          | 1           |
| Missing field of view   | 1           |

“Insufficient boundaries” does not establish that every line is occluded. The
method requires a supported camera fit followed by all travel-lane boundaries
and an unambiguous lane correspondence. The other results withhold the photo
or leave a relevant image bare according to the current contracts.

Three separate throwaway experiments retained the existing acceptance gates:

- Decode all 32 regular photos from SD assets instead of thumbnails: zero
  registrations in the offline pixel probe. Resolution alone is insufficient.
- Balance the fit objective across boundary supports with a geometric mean:
  zero registrations. A supported pose at one site still had a competing layout.
- Expand the heading search from ±6° to ±18° with SD inputs: one offline panorama
  candidate, which was not accepted by the real browser canvas/worker replay.
  This did not establish improved guidance and was not adopted.

The separate two-lane panorama calibration remains a transformation control,
not general usefulness evidence. No frozen correctness or usefulness threshold
was relaxed to create a positive result.

## Local learned-detector experiment

Ran the authors' [Ultra Fast Lane Detection v2](https://github.com/cfzd/Ultra-Fast-Lane-Detection-v2)
ResNet18/CULane checkpoint on all 32 SD regular images. Source revision:
`c903880678454dfd9b55a63022368db05c00bc6d`. Checkpoint SHA-256:
`956616371ee758551c455d28c1c8a9732b39d7fbd85bc70b9869424a5121f967`.
Loading used `weights_only=True` and strict state-dictionary matching. Processing
used the authors' RGB normalization, bottom crop and row/column decoding. This
was local CPU inference, not a browser, mobile or panorama benchmark.

| Observation                    | Result              |
| ------------------------------ | ------------------- |
| Frames                         | 32                  |
| At least one predicted curve   | 27                  |
| Predicted curves per image     | 0–4                 |
| Complete junction-count match  | 2                   |
| Median inference, four threads | 89 ms               |
| p95 inference, nearest rank    | 120 ms              |
| Float32 parameter storage      | 825,202,560 bytes   |
| Peak Python process RSS        | 2,231,681,024 bytes |

The two count matches were already withheld by route-context checks. Visual
inspection also showed why a count match cannot establish global lane identity:
some predictions cover only the camera's nearby lanes, miss an outer edge,
track a vehicle, or track construction paint. Four output curve slots cannot
represent every boundary of a four-, five- or six-lane carriageway. Predicted
curves are neither calibrated confidence nor proof of route-lane correspondence.

This checkpoint was not adopted. It has not demonstrated useful complete-lane
coverage here, its measured float32 footprint is unsuitable for this mobile
feature, and code licensing alone does not certify training-data or weight
redistribution rights. The authors' code is MIT licensed; no model, dependency
or third-party processing was added to the application. This result does not
rule out a smaller, differently trained model with variable boundary counts.

## Release decision

General photo guidance remains unvalidated. The current method's zero accepted
overlays fail the usefulness gate; the detector experiment does not replace the
missing independent lane/scene reference masks. A future method must establish
complete photographed-layout identity, contain every filled corridor inside its
intended travel lane, reject shoulders/gore/other carriageways, and pass the
held-out and representative-device gates before adoption.
