# PinPoint 📍💕

Pin the places you've been on a world map — solo, or on a shared map with someone else. Start a map, get a short invite code, send it to a friend or partner, and pinpoint the places you've been together in real time.

## Features

- Click-to-pin on an interactive world map (Leaflet + OpenStreetMap tiles)
- **Shared maps**: create a map, get a 6-character code, and anyone with the code can join and pin alongside you
- Pins update live for everyone on the map via WebSockets — no refresh needed
- Each person picks a name and a color; pins and the sidebar show who added what
- Sidebar list of all pinned places, with search
- Edit / delete pins from the map popup or the sidebar
- Stats: total places and countries visited
- Light/dark theme toggle, cute pastel UI with smooth transitions
- Export a map's pins to JSON

## Stack

A small full-stack app — no external accounts or services required:

- **Server**: Node.js + Express, serving the API and the static frontend
- **Database**: SQLite via Node's built-in `node:sqlite` module (file-based, zero setup)
- **Realtime**: WebSockets (`ws`) to sync pins between everyone on the same map
- **Frontend**: vanilla HTML/CSS/JS + Leaflet, no build step

## Running locally

Requires Node.js 22.5+ (uses the built-in `node:sqlite` module).

```bash
npm install
npm start
```

Then open `http://localhost:3000`. The database file is created automatically at `data/pinpoint.sqlite`.

## Sharing a map with someone else

1. Create a map and pick your name and color.
2. Click the code chip in the top bar to copy an invite link (`/m/CODE`), or just share the 6-character code.
3. The other person opens the app, chooses "Join with a code", enters the code and their own name/color.
4. From then on, pins either of you add appear on both screens instantly.

To let someone outside your network join, you'll need to deploy this app somewhere reachable (e.g. Render, Railway, Fly.io) — running it with `npm start` only serves it on your machine.

## Deploying

The app is a single Node process with a file-based SQLite database, so any host that gives you a **persistent disk/volume** works. The database (and any uploaded photos) live under `./data`, resolved relative to `server/db.js` — mount your volume there and nothing else needs to change.

### Docker (any host)

```bash
docker build -t pinpoint .
docker run -p 3000:3000 -v pinpoint_data:/app/data pinpoint
```

The `Dockerfile` uses `node:22-slim` (needed for the built-in `node:sqlite` module) and declares `/app/data` as a volume.

### Render

1. Push this repo to GitHub/GitLab and create a new **Blueprint** on [Render](https://render.com) pointing at it — it reads `render.yaml` and provisions the web service plus a 1GB persistent disk mounted at the app's `./data` directory automatically.
2. Alternatively, create a Node web service by hand: build command `npm ci --omit=dev`, start command `node server/index.js`, and attach a disk mounted at `/opt/render/project/src/data`.

### Fly.io

```bash
fly launch --no-deploy        # generates/attaches an app; rename `app` in fly.toml if it differs
fly volumes create pinpoint_data --size 1 --region iad
fly deploy
```

`fly.toml` mounts the volume at `/app/data` and exposes the app over HTTPS.

### Railway

1. Create a new project from this repo — Railway's Nixpacks builder auto-detects Node and uses `railway.json` for the start command.
2. In the service's **Settings → Volumes**, attach a volume mounted at `/app/data` (Railway's Nixpacks build runs from `/app`) so the database survives redeploys.

## Data

All maps and pins live in the SQLite database at `data/pinpoint.sqlite` on the server. Each browser remembers its name/color per map (in `localStorage`) so you don't have to re-enter it every visit.

## Installable / offline (PWA)

PinPoint is installable on desktop and mobile (`manifest.webmanifest`) and registers a service worker (`public/sw.js`) that:

- Caches the app shell (HTML/JS/CSS) so the app still opens with no connection.
- Caches each map's last-fetched data (`/api/maps/:code`), so a map you've already opened stays viewable (read-only) offline.
- Leaves map tiles and pin writes untouched — editing pins and loading new map tiles still require a connection.

Bump `CACHE_VERSION` in `public/sw.js` whenever the cached app-shell files change, so returning visitors pick up the new version instead of a stale cached one.
