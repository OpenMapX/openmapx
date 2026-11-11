# iRail API fixtures

Example responses from the iRail API documentation at https://docs.irail.be/,
retrieved 2026-11-10: `liveboard.json` (Liveboard), `connections.json`
(Connections) and `vehicle.json` (Vehicle). Whitespace that the documentation's
HTML rendering inserted into keys and values was removed; the data is otherwise
unchanged, including its placeholder values. No credentials or personal data are
involved: the API is keyless.

The documentation types numbers as JSON numbers, while the live API sends most of
them as numeric strings. The adapter accepts both, and the inline test payloads
cover the string form.
