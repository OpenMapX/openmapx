---
"web": patch
---

Stop server renders from holding every request in memory for up to an hour. Each render's queries armed a garbage-collection timer for their `gcTime`, and each timer kept the whole request alive until it fired; about 600 page loads within an hour exhausted the web container's heap. A server render's queries now use `gcTime: Infinity`, which arms no timer, so they are freed with the request.
