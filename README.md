# PinPoint 📍

A simple web app for pinpointing the places you've been on a world map.

Click anywhere on the map to drop a pin, give it a name, country, date, notes, and a rating. Your pins are saved locally in your browser (`localStorage`) — no account or backend required.

## Features

- Click-to-pin on an interactive world map (Leaflet + CARTO tiles)
- Sidebar list of all your places, with search
- Edit / delete pins from the map popup or the sidebar
- Stats: total places and countries visited
- Light/dark theme toggle
- Export your pins to JSON and import them back (handy for backups or moving devices)

## Running locally

This is a static site — no build step. Because it fetches map tiles and libraries from a CDN, serve it over `http://` rather than opening the file directly:

```bash
# Python
python -m http.server 8000

# or Node
npx serve .
```

Then open `http://localhost:8000`.

## Data

All places are stored in your browser's `localStorage` under the key `pinpoint.places.v1`. Nothing is sent to a server. Use the **Export** button to back up your data as JSON, and **Import** to restore or merge it elsewhere.
