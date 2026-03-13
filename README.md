# metaserver

A lightweight dashboard that displays links to services running on a machine, with live health status updates via Server-Sent Events.

## Features

- **Single-page dashboard** — cards for each service with name, description, icon, and live status
- **Live health checks** — every 30 seconds, each service is pinged and the status dot updates (green/red/grey) without a page reload
- **Hot config reload** — edit `config.yaml` and the dashboard updates instantly via SSE, no restart needed
- **Minimal dependencies** — one production dependency (`js-yaml`)

## Quick Start

```bash
npm install
# edit config.yaml with your services
PORT=8080 node server.js
```

Open `http://localhost:8080` in your browser.

## Configuration

Edit `config.yaml`:

```yaml
services:
  - name: Gitea
    url: https://git.example.com
    icon: gitea.png          # place file in icons/
    description: Self-hosted Git

  - name: Jellyfin
    url: http://192.168.1.50:8096
    description: Media server
```

| Field       | Required | Description                                             |
|-------------|----------|---------------------------------------------------------|
| name        | yes      | Display name on the card                                |
| url         | yes      | Full URL (used for link and health check)               |
| icon        | no       | Filename in `icons/` directory (PNG, SVG, etc.)         |
| description | no       | One-liner shown below the name                          |

If `icon` is omitted, a colored circle with the service's first letter is shown.

Cards appear in config file order. The page title is the machine's hostname.

## Icons

Place icon files (PNG, SVG, JPG, WebP) in the `icons/` directory and reference them by filename in `config.yaml`.

## Installation (systemd)

1. Copy the project to `/opt/metaserver`:
   ```bash
   sudo cp -r . /opt/metaserver
   ```

2. Install dependencies:
   ```bash
   cd /opt/metaserver
   sudo npm install --production
   ```

3. Create a system user:
   ```bash
   sudo useradd --system --no-create-home metaserver
   ```

4. Set ownership:
   ```bash
   sudo chown -R metaserver:metaserver /opt/metaserver
   ```

5. Install the systemd unit:
   ```bash
   sudo cp metaserver.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now metaserver
   ```

The dashboard will be available on port 80. To use a different port, add `Environment=PORT=8080` to the `[Service]` section of the unit file.

## Endpoints

| Path      | Description                              |
|-----------|------------------------------------------|
| `/`       | Dashboard HTML page                      |
| `/events` | SSE stream (state, reload, health events)|
| `/icons/*`| Static icon files                        |
| `/health` | JSON health check (`{"status":"ok"}`)    |
