---
title: EEA ground-provider review
description: Why the optional official EEA UTD/hybrid provider is blocked.
---

# EEA ground-provider review

**Decision:** a request-time provider is blocked; raw UTD needs a separate
background ingestion component.

The EEA Air Quality Download Service is a documented, CC BY 4.0 source for raw
verified and up-to-date observations. Its supported API creates bulk Parquet
downloads filtered by fields such as country, city, pollutant, source, method,
aggregation, and date range. It is not a bounded low-latency point/station API,
and its delivery workflow is unsuitable for execution inside a canonical
request deadline. The public European AQI viewer separately documents CAMS gap
filling, but the download contract does not identify each viewer gap-filled
sample.

## Required ingestion architecture

A future raw-UTD component should be an independently operated pipeline:

1. schedule country/pollutant/date partitions and retain the immutable download
   request plus artifact checksum;
2. stage and validate Parquet schemas, units, station identities, coordinates,
   aggregation periods, method/source fields, and observation times;
3. reject changed or internally inconsistent partitions before promotion;
4. store versioned station/pollutant intervals with artifact and row-level
   provenance, plus an atomic latest-complete pointer;
5. serve bounded spatial/time queries from that store with explicit ingest age
   and source update time;
6. label the result raw UTD only. Never set `gapFilled`, `hybrid`, or CAMS
   provenance unless a future official per-sample contract proves it.

The initial operating policy should request rolling country/pollutant partitions
hourly, retry a failed partition after 15 minutes with bounded backoff, and run a
daily seven-day reconciliation for late corrections. Promotion is atomic per
partition and requires a matching artifact checksum, the expected schema,
internally consistent station coordinates and units, no duplicate station/time/
pollutant rows, and a non-regressing source update time. A failed candidate
leaves the previous complete partition active.

Freshness is measured from the newest source observation, never from download
completion. Three hours is the soft current-data threshold: older rows remain
visible only as stale evidence. Twelve hours is the hard threshold: the serving
layer returns no current evidence from that partition. Forecast, history, and
backfill products need separate thresholds rather than inheriting these current-
observation values.

The ingestion service also needs operator-owned storage, scheduling, retry,
retention, and monitoring. Adding those operational commitments to an API
process would create a fragile downloader and still would not reproduce the
viewer hybrid feed.

Revisit the raw-UTD path when OpenMapX is ready to operate that ingestion/store
boundary and the download workflow can be automated without representing an
operator or end user. Revisit hybrid evidence only when an official documented
endpoint exposes station classification and per-sample quality/gap-fill
identity. Until then, OpenAQ remains the request-time ground source and
Open-Meteo/CAMS remains separately identified model evidence.

- [EEA Air Quality Download Service](https://www.eea.europa.eu/en/datahub/datahubitem-view/778ef9f5-6293-4846-badd-56a29c70880d)
- [European Air Quality Index methodology](https://airindex.eea.europa.eu/AQI/?webgl=0)
