# The three web apps on the network

| App | Firebase site | Plays | Uses |
|---|---|---|---|
| bana-pele-naledi-mobileview | bana-pele-naledi-ui | Naledi (practitioner) | `POST /v1/search`, `GET /v1/transactions?practitionerId=`, `GET /v1/results/{id}`, `POST /v1/select`, `POST /v1/confirm` |
| bana-pele-ngo-webview | bana-pele-ngo-ui | WeHelp (NGO, `provider-wehelp`) | `GET /v1/commitments`, `POST /v1/provider/decision`, `POST /v1/provider/complete` |
| bana-pele-thabo-webview | bana-pele-thabo-ui | Thabo (coach, `coach_thabo_nkosi`) | `GET /v1/commitments?coachId=` |

Each app reads `VITE_API_BASE_URL` and `VITE_API_KEY` at build time. Without
them it runs on its built-in demo data, exactly as before.

The edge allows browser calls (CORS) only from those three sites and
`localhost`; change `CORS_ORIGINS_REGEX` in `edge.Caddyfile` to add others.
The base URL must be HTTPS (tunnel or Azure) for the Firebase-hosted apps.

Note: a `VITE_` key is visible to anyone who opens the app. Fine for the
sandbox with made-up data; before real data, the apps need their own login and
a server-side key.
