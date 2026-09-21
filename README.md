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

## Data

All maps and pins live in the SQLite database at `data/pinpoint.sqlite` on the server. Each browser remembers its name/color per map (in `localStorage`) so you don't have to re-enter it every visit.
