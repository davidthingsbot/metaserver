const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const PORT = parseInt(process.env.PORT, 10) || 80;
const CONFIG_PATH = path.join(__dirname, 'config.yaml');
const ICONS_DIR = path.join(__dirname, 'icons');
const HEALTH_CHECK_INTERVAL = 30_000;
const HEALTH_CHECK_TIMEOUT = 5_000;
const DEBOUNCE_MS = 300;

let services = [];
let healthStatus = new Map(); // name -> 'online' | 'offline' | 'unknown'
let sseClients = new Set();
let healthCheckTimer = null;

// --- Config loading ---

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const doc = yaml.load(raw);
  if (!doc || !Array.isArray(doc.services)) {
    throw new Error('config.yaml must contain a "services" array');
  }

  const names = new Set();
  for (const svc of doc.services) {
    if (!svc.name || !svc.url) {
      throw new Error(`Each service must have "name" and "url". Got: ${JSON.stringify(svc)}`);
    }
    if (names.has(svc.name)) {
      throw new Error(`Duplicate service name: "${svc.name}"`);
    }
    names.add(svc.name);

    if (svc.icon) {
      const iconPath = path.join(ICONS_DIR, svc.icon);
      if (!fs.existsSync(iconPath)) {
        console.warn(`Warning: icon file not found: ${iconPath}`);
      }
    }
  }

  return doc.services;
}

function applyConfig(newServices) {
  services = newServices;
  healthStatus = new Map();
  for (const svc of services) {
    healthStatus.set(svc.name, 'unknown');
  }
}

// --- File watching ---

let debounceTimeout = null;

function watchConfig() {
  fs.watch(CONFIG_PATH, () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      try {
        const newServices = loadConfig();
        applyConfig(newServices);
        console.log(`Config reloaded: ${services.length} services`);
        broadcast('reload', getStatePayload());
        runHealthChecks();
      } catch (err) {
        console.error('Config reload failed, keeping previous config:', err.message);
      }
    }, DEBOUNCE_MS);
  });
}

// --- Health checks ---

function checkHealth(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    let redirects = 0;

    function doRequest(targetUrl) {
      const opts = new URL(targetUrl);
      const reqOpts = {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.pathname + opts.search,
        method: 'GET',
        timeout: HEALTH_CHECK_TIMEOUT,
        rejectAuthorized: false,
      };

      // For https, disable cert validation
      if (targetUrl.startsWith('https')) {
        reqOpts.rejectUnauthorized = false;
      }

      const reqMod = targetUrl.startsWith('https') ? https : http;
      const req = reqMod.request(reqOpts, (res) => {
        // Consume body to free socket
        res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
          redirects++;
          let location = res.headers.location;
          if (location.startsWith('/')) {
            location = `${opts.protocol}//${opts.host}${location}`;
          }
          doRequest(location);
        } else if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve('online');
        } else {
          resolve('offline');
        }
      });

      req.on('error', () => resolve('offline'));
      req.on('timeout', () => {
        req.destroy();
        resolve('offline');
      });
      req.end();
    }

    doRequest(url);
  });
}

async function runHealthChecks() {
  const results = await Promise.allSettled(
    services.map(async (svc) => {
      const status = await checkHealth(svc.url);
      healthStatus.set(svc.name, status);
    })
  );

  const healthPayload = {};
  for (const [name, status] of healthStatus) {
    healthPayload[name] = status;
  }
  broadcast('health', healthPayload);
}

function startHealthChecks() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  runHealthChecks();
  healthCheckTimer = setInterval(runHealthChecks, HEALTH_CHECK_INTERVAL);
}

// --- SSE ---

function getStatePayload() {
  return services.map((svc) => ({
    name: svc.name,
    url: svc.url,
    icon: svc.icon || null,
    description: svc.description || null,
    status: healthStatus.get(svc.name) || 'unknown',
  }));
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send current state immediately
  const msg = `event: state\ndata: ${JSON.stringify(getStatePayload())}\n\n`;
  res.write(msg);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

// --- Icon serving ---

const MIME_TYPES = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function handleIcon(req, res) {
  const filename = path.basename(req.url.slice('/icons/'.length));
  const filePath = path.join(ICONS_DIR, filename);

  // Prevent directory traversal
  if (!filePath.startsWith(ICONS_DIR)) {
    res.writeHead(404);
    res.end();
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
  });
}

// --- HTML template ---

function buildHTML() {
  const hostname = os.hostname();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(hostname)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #0f1117;
    color: #e1e4e8;
    min-height: 100vh;
    padding: 2rem;
  }

  header {
    text-align: center;
    margin-bottom: 2.5rem;
  }

  header h1 {
    font-size: 1.75rem;
    font-weight: 600;
    color: #f0f3f6;
    letter-spacing: 0.02em;
  }

  header p {
    color: #6b7280;
    font-size: 0.875rem;
    margin-top: 0.35rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1.25rem;
    max-width: 1200px;
    margin: 0 auto;
  }

  .card {
    background: #1a1d27;
    border: 1px solid #2a2d37;
    border-radius: 12px;
    padding: 1.25rem;
    display: flex;
    align-items: center;
    gap: 1rem;
    text-decoration: none;
    color: inherit;
    transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
    cursor: pointer;
  }

  .card:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    border-color: #3a3d4a;
  }

  .card-icon {
    width: 48px;
    height: 48px;
    border-radius: 10px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .card-icon img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .card-icon .fallback {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    font-weight: 700;
    color: #fff;
    border-radius: 10px;
  }

  .card-body {
    flex: 1;
    min-width: 0;
  }

  .card-title {
    font-size: 1rem;
    font-weight: 600;
    color: #f0f3f6;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background-color 0.3s ease;
  }

  .status-dot.online { background: #22c55e; box-shadow: 0 0 6px rgba(34, 197, 94, 0.5); }
  .status-dot.offline { background: #ef4444; box-shadow: 0 0 6px rgba(239, 68, 68, 0.4); }
  .status-dot.unknown { background: #6b7280; }

  .card-desc {
    font-size: 0.8125rem;
    color: #8b949e;
    margin-top: 0.2rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .empty {
    text-align: center;
    color: #6b7280;
    padding: 4rem 1rem;
    font-size: 1rem;
  }
</style>
</head>
<body>
<header>
  <h1>${escapeHTML(hostname)}</h1>
  <p>Service Dashboard</p>
</header>
<div class="grid" id="grid">
  <div class="empty">Connecting…</div>
</div>

<script>
const COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#f43f5e','#f97316',
  '#eab308','#22c55e','#14b8a6','#06b6d4','#3b82f6'
];

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

function escapeHTML(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderCards(services) {
  const grid = document.getElementById('grid');
  if (!services || services.length === 0) {
    grid.innerHTML = '<div class="empty">No services configured</div>';
    return;
  }

  grid.innerHTML = services.map(svc => {
    const iconHTML = svc.icon
      ? '<img src="/icons/' + encodeURIComponent(svc.icon) + '" alt="" loading="lazy">'
      : '<div class="fallback" style="background:' + hashColor(svc.name) + '">' + escapeHTML(svc.name.charAt(0).toUpperCase()) + '</div>';

    const descHTML = svc.description
      ? '<div class="card-desc">' + escapeHTML(svc.description) + '</div>'
      : '';

    return '<a class="card" href="' + escapeHTML(svc.url) + '" target="_blank" rel="noopener noreferrer" data-name="' + escapeHTML(svc.name) + '">'
      + '<div class="card-icon">' + iconHTML + '</div>'
      + '<div class="card-body">'
      + '<div class="card-title"><span>' + escapeHTML(svc.name) + '</span><span class="status-dot ' + (svc.status || 'unknown') + '"></span></div>'
      + descHTML
      + '</div></a>';
  }).join('');
}

function updateHealth(healthMap) {
  for (const [name, status] of Object.entries(healthMap)) {
    const card = document.querySelector('.card[data-name="' + CSS.escape(name) + '"]');
    if (card) {
      const dot = card.querySelector('.status-dot');
      if (dot) {
        dot.className = 'status-dot ' + status;
      }
    }
  }
}

let services = [];

const es = new EventSource('/events');

es.addEventListener('state', (e) => {
  services = JSON.parse(e.data);
  renderCards(services);
});

es.addEventListener('reload', (e) => {
  services = JSON.parse(e.data);
  renderCards(services);
});

es.addEventListener('health', (e) => {
  const healthMap = JSON.parse(e.data);
  updateHealth(healthMap);
  // Also update local state
  for (const svc of services) {
    if (healthMap[svc.name]) svc.status = healthMap[svc.name];
  }
});
</script>
</body>
</html>`;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- HTTP server ---

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/events') {
    return handleSSE(req, res);
  }

  if (url.startsWith('/icons/')) {
    return handleIcon(req, res);
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Serve dashboard for everything else
  const html = buildHTML();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

// --- Startup ---

try {
  const initialServices = loadConfig();
  applyConfig(initialServices);
  console.log(`Loaded ${services.length} services from config`);
} catch (err) {
  console.error('Failed to load config:', err.message);
  process.exit(1);
}

watchConfig();

server.listen(PORT, () => {
  console.log(`metaserver listening on port ${PORT}`);
  startHealthChecks();
});
