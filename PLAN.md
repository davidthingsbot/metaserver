# metaserver — Project Plan

A lightweight dashboard web server that displays links to services running on a machine, with live health status.

---

## 1. Tech Stack

| Choice | What | Why |
|--------|------|-----|
| **Runtime** | Node.js (no framework) | Built-in `http`, `fs`, `os` modules cover all needs. No Express needed — we serve one page and one SSE endpoint. |
| **Config format** | YAML (`config.yaml`) | More readable than JSON for humans editing by hand. Single dep: `js-yaml`. |
| **Live reload** | Server-Sent Events (SSE) | Simpler than WebSocket for unidirectional server→browser pushes. No extra library needed — just `text/event-stream` over a kept-alive HTTP response. No WS upgrade dance, no ping/pong framing. |
| **File watching** | `fs.watch` | Built-in, sufficient for a single config file. We debounce by 300ms to ignore duplicate events. |
| **Health checks** | `http.get` / `https.get` | Built-in. No need for `fetch` polyfills or axios. |
| **HTML/CSS** | Inline in a JS template literal | One file serves everything — no bundler, no static file complexity. CSS uses system font stack + CSS grid for card layout. |
| **Process manager** | systemd | Standard on all modern Linux. Simple `Type=simple` unit. |

**Total production dependencies: 1** (`js-yaml`).

---

## 2. File & Directory Structure

```
metaserver/
├── PLAN.md              # This file
├── README.md
├── package.json
├── server.js            # Entry point — all server logic
├── config.yaml          # Service definitions (user-edited)
├── icons/               # Static icon/logo files (PNG/SVG)
│   └── example.png
└── metaserver.service   # systemd unit file
```

Why flat? There's one source file. No `src/`, no `lib/`, no `dist/`. If complexity grows later, refactor then.

---

## 3. Config File Format

```yaml
# config.yaml
services:
  - name: Gitea
    url: https://git.example.com
    icon: gitea.png          # resolved relative to icons/
    description: Self-hosted Git

  - name: Jellyfin
    url: http://192.168.1.50:8096
    icon: jellyfin.svg
    description: Media server

  - name: Portainer
    url: https://docker.example.com:9443
    # icon omitted — will show first letter of name as fallback
    description: Docker management

  - name: Router
    url: http://192.168.1.1
    # description omitted — card just shows name + status
```

**Fields:**

| Field | Required | Type | Notes |
|-------|----------|------|-------|
| `name` | yes | string | Display name on the card |
| `url` | yes | string | Full URL including protocol and port. Used for both the link and health check target. |
| `icon` | no | string | Filename in `icons/`. If absent, render a colored circle with the first letter. |
| `description` | no | string | One-liner shown below the name. |

Validation at startup: reject duplicate names, reject entries missing `name` or `url`, warn on icon files that don't exist.

---

## 4. Live Reload (Config Change → Browser Update)

```
  config.yaml modified
        │
        ▼
  fs.watch fires ──► debounce 300ms ──► re-read & parse config.yaml
                                              │
                                              ▼
                                     validate new config
                                      (on error: log, keep old)
                                              │
                                              ▼
                                     update in-memory service list
                                     reset health check state
                                              │
                                              ▼
                                     broadcast SSE event to all
                                     connected clients:
                                       event: reload
                                       data: { services: [...] }
                                              │
                                              ▼
                                     browser JS receives event,
                                     re-renders cards without
                                     full page reload
```

**SSE endpoint:** `GET /events`

The browser opens an `EventSource('/events')`. On connect, the server immediately sends the current state (services + their last-known health status) so the client doesn't need a separate initial fetch.

**Event types sent over SSE:**

| Event | When | Data |
|-------|------|------|
| `state` | On initial connect | Full service list with current health status |
| `reload` | Config file changed | Full service list (health status reset to `unknown`) |
| `health` | After each health check cycle | Map of service name → `online`/`offline` |

---

## 5. Health Checks

**Mechanism:**

- A `setInterval` runs every **30 seconds** (configurable later if needed).
- For each service, issue an HTTP/HTTPS GET to its `url`.
- Timeout per request: **5 seconds**.
- A service is **online** if the response status is 2xx or 3xx (redirects count — the service is responding).
- A service is **offline** if: connection refused, timeout, DNS failure, 4xx, or 5xx.
- Results are stored in a `Map<serviceName, 'online' | 'offline' | 'unknown'>`.
- After all checks complete, broadcast a `health` SSE event.

**On startup:** All services start as `unknown`. First health check runs immediately (not waiting 30s).

**Concurrency:** All health checks for a cycle run in parallel via `Promise.allSettled`. One slow service doesn't block the others.

**Edge cases:**
- If a service URL uses HTTPS with a self-signed cert, Node will reject it. We'll set `rejectUnauthorized: false` for health checks only (not for the user's browser — that's their choice). This is a dashboard, not a security scanner.
- Health checks follow up to 3 redirects (to handle reverse proxy setups), but the redirect chain is not exposed to the user.

---

## 6. systemd Unit File

```ini
# metaserver.service
[Unit]
Description=metaserver dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/metaserver
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/metaserver
PrivateTmp=true

# Bind to port 80 without running as root
AmbientCapabilities=CAP_NET_BIND_SERVICE
User=metaserver
Group=metaserver

[Install]
WantedBy=multi-user.target
```

**Installation steps** (to be documented in README):

1. Copy project to `/opt/metaserver`
2. `npm install --production`
3. Create system user: `useradd --system --no-create-home metaserver`
4. `chown -R metaserver:metaserver /opt/metaserver`
5. Copy `metaserver.service` to `/etc/systemd/system/`
6. `systemctl daemon-reload && systemctl enable --now metaserver`

---

## 7. Open Questions & Tradeoffs

### Decided, noting the tradeoff

- **Port 80 requires privilege.** Handled via `CAP_NET_BIND_SERVICE` in the systemd unit so the process runs as an unprivileged user. Alternative: run on a high port and reverse-proxy. We go with the capability approach since this is meant to be the entry-point page and adding nginx defeats the "minimal" goal.

- **Single-file `server.js`.** This will be ~300-400 lines. Acceptable for a project this small. If it grows past ~500 lines, split into modules.

- **No HTTPS.** This is a LAN dashboard. TLS can be added via a reverse proxy if needed. Not in scope.

### Open — decide during implementation

- **Should the health check interval be configurable in `config.yaml`?** Leaning no for now (YAGNI). The 30s default is reasonable. Can add a top-level `healthCheckInterval` field later without breaking anything.

- **Should cards link directly or open in a new tab?** Leaning `target="_blank"` with `rel="noopener"` since users probably want to keep the dashboard open. Will go with this unless it feels wrong during implementation.

- **Card sort order:** match config file order, or alphabetical? Config file order — the user controls the layout by reordering entries in YAML. No magic.

- **Favicon:** Generate one from the hostname's first letter, or skip? Low priority — skip unless trivial to add.
