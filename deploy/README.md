# Production containers (issue #13)

```
 internet ── Traefik / managed NGINX ──(publicweb)── supply-360 (NGINX) ──(supply)──┬── web:3000  (Next.js)
             TLS, domains, web UI                    path routing                    ├── api:4000  (NestJS)
                                                                                     └── postgres:5432
```

- **supply-360** is the reverse proxy container. `/api/...` goes to the API (JSON API, SampTrek webhooks and S2S
  callbacks, respondent links `/api/v1/i/...` and `/api/v1/r/...`); every other path goes to the web app.
  `/api/v1/metrics` answers 404 here; Prometheus scrapes `http://api:4000/api/v1/metrics` on the `supply` network.
- **No container publishes a port.** Nothing is reachable from the host or the internet except through publicweb.
- **supply** is the private network between the containers. It is an ordinary bridge rather than `internal: true`
  because the API has to reach SampTrek and MADP.
- **publicweb** is external and managed separately. Only supply-360 joins it. Point the edge proxy at
  `http://supply-360:80`, have it terminate TLS and send `X-Forwarded-Proto: https`. With Traefik, add these labels
  to the `proxy` service or define the router in Traefik's own dynamic config:

  ```yaml
  labels:
    traefik.enable: 'true'
    traefik.docker.network: publicweb
    traefik.http.routers.supply360.rule: Host(`supply360.example.com`)
    traefik.http.routers.supply360.entrypoints: websecure
    traefik.http.routers.supply360.tls.certresolver: letsencrypt
    traefik.http.services.supply360.loadbalancer.server.port: '80'
  ```

## Run

```
docker network create publicweb        # once, unless the edge proxy's stack created it
cp .env.example .env                   # production values; the API refuses to start on unsafe ones
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

The `migrate` job applies migrations and creates or updates the `s360_api` login role from `S360_API_DB_PASSWORD`,
so there is no manual psql step. The API runs with `TRUST_PROXY_HOPS=2` (the edge proxy and supply-360 both append
to `X-Forwarded-For`), so sign-in throttling and session records use the real client address. If the edge proxy is
removed or another hop is added, change that number.

Deploying to production still follows [../docs/runbooks/deployment.md](../docs/runbooks/deployment.md) and needs an
approved change.

## Checked (2026-11-26, local Docker 29.9.3)

From a container on publicweb only, playing the edge proxy:

| Request | Result |
|---|---|
| `GET /login`, `GET /` | 200 from web, with HSTS and the nonce CSP |
| `GET /api/v1/health`, `/api/v1/health/ready` | 200 from the API |
| `GET /api/v1/metrics` | 404 at supply-360 |
| `GET /api/v1/i/demo/<bad token>` | 302 to `https://supply360.test/done/invalid` |
| `api:4000`, `web:3000`, `postgres:5432` directly | not resolvable from publicweb |
| 12 failed sign-ins from client A | 10 × 401 then 429; client B still 401; A spoofing `X-Forwarded-For` still 429 |

`docker ps` showed no published ports, and the sign-in page rendered in Chromium through the proxy with no console
errors. CI checks on every pull request that the file is valid, that no service publishes a port, that only the
proxy is on publicweb, and that the NGINX config passes `nginx -t`.
