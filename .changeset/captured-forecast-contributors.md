---
"@openmapx/core": major
---

Weather forecast providers now return `WeatherForecastResponse<T>` envelopes with `source`, `points` and captured contributor receipts instead of bare hourly/daily arrays. Forecast points retain their own receipts for later filtering, and the generic forecast API preserves the selected fallback supplier through caching.
