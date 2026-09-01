# Spotify Lyrics — Real-time lyrics for your Tesla

Web Spotify player that shows real-time synchronized lyrics with play/pause controls, designed to be used from the Tesla browser.

## Architecture

```
spotify-lyrics/
├── src/
│   └── server.js        # Express backend (OAuth + Spotify proxy + LRCLIB lyrics)
├── public/
│   ├── index.html        # Main UI
│   ├── style.css         # Styles (Tesla dark/light theme)
│   ├── app.js            # Frontend logic (polling, sync, controls)
│   └── favicon.svg       # Project icon
├── .env                  # Credentials (never commit)
├── .env.example          # .env template
└── package.json          # Dependencies: express, axios, dotenv
```

## Stack

- **Backend**: Node.js + Express, Spotify Authorization Code Flow
- **Frontend**: vanilla HTML/CSS/JS (no framework)
- **Lyrics**: LRCLIB API (free, open, no API key — https://lrclib.net)
- **Local exposure**: Cloudflare Tunnel (cloudflared) for HTTPS access from Tesla
- **Hosting**: Railway (free tier), see [Deployment](#deployment)

## Dependencies

```bash
npm install   # Installs express, axios, dotenv
```

## Configuration

### 1. Create an app in the Spotify Developer Dashboard

1. Go to https://developer.spotify.com/dashboard
2. Create app → any name
3. In **Edit Settings → Redirect URIs** add the callback URL:
   - Local: `http://127.0.0.1:3000/callback` (must use `127.0.0.1`, NOT `localhost`)
   - Remote (Cloudflare Tunnel): `https://<your-url>.trycloudflare.com/callback`
   - Remote (Railway): `https://<your-app>.up.railway.app/callback`
4. Copy **Client ID** and **Client Secret**

### 2. Create `.env`

```bash
cp .env.example .env
```

Fill in the credentials:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
PORT=3000
```

## Run locally

```bash
node src/server.js
```

- Server at http://127.0.0.1:3000
- Open in a browser and sign in with Spotify
- Each user's tokens are stored in their browser's `localStorage` (multi-tenant)

## Deployment (Railway)

1. Push the repo to GitHub and create a Railway project from it, or use `railway up`.
2. Set the environment variables `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `PORT=3000` and `BASE_URL=https://<your-app>.up.railway.app` in the Railway dashboard.
3. Add `https://<your-app>.up.railway.app/callback` to the Redirect URIs in the Spotify Developer Dashboard.
4. The service runs `npm start` (`node src/server.js`).

Live app: https://spotify-lyrics-production.up.railway.app

## Expose for Tesla (Cloudflare Tunnel)

1. Download cloudflared: https://developers.cloudflare.com/tunnel/downloads/
2. Keep the binary in a stable folder
3. Start the tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate
```

4. Copy the `https://xxx.trycloudflare.com` URL it prints
5. If it's the first time: add the URL as a redirect in the Spotify Dashboard
6. Open the URL in the Tesla browser

**Note**: the trycloudflare.com URL is temporary and changes when cloudflared restarts. Each user's session lives in their browser's localStorage, so they don't need to re-authenticate as long as they use the same browser.

To stop:
- `Get-Process node,cloudflared | Stop-Process -Force`

## How it works

### Auth (server.js)

- Multi-tenant: each user signs into Spotify with their own account.
- Authorization Code Flow with scopes: `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`.
- `GET /api/auth-url` returns the Spotify authorization URL.
- `GET /callback` exchanges the code and serves a tiny HTML page that stores the tokens in the browser's `localStorage` (the refresh token never passes through the URL/history).
- `POST /api/token` exchanges a user's refresh token for a new access token (the Client Secret stays on the server).
- The refresh token doesn't expire → once authenticated, no re-login needed.
- The access token is renewed automatically on the frontend when it expires.

### Lyrics (LRCLIB)

- Free, open API: `https://lrclib.net/api/get?track_name=...&artist_name=...&album_name=...&duration=...`
- Returns `syncedLyrics` (LRC format with timestamps) or `plainLyrics`
- `parseLRC()` converts LRC to `{startTimeMs, text}`
- 60-minute cache per trackId to avoid querying on every poll
- Search by song name + artist + album + duration (not by Spotify ID)

### Frontend (app.js)

- Polling every 1 second to `/api/player` with `Authorization: Bearer <access_token>`
- `updateSync()` runs every 100ms computing the active line with `performance.now() - startDate`
- When paused, progress is frozen in `pausedProgress` (lyrics don't advance)
- Tesla theme: `html[data-theme="dark"]` / `html[data-theme="light"]` with the official Tesla palette
  - Dark: background `#000000`, surface `#171A20`, text `#FFFFFF`
  - Light: background `#FFFFFF`, surface `#F4F4F4`, text `#171A20`
- Theme persisted in `localStorage`
- Inline SVG icons (prev/play/next), minimalist, no accent color
- Logout button clears the user's tokens from `localStorage`

### Controls

- `/api/player/play` → PUT `https://api.spotify.com/v1/me/player/play`
- `/api/player/pause` → PUT `https://api.spotify.com/v1/me/player/pause`
- `/api/player/next` → POST `https://api.spotify.com/v1/me/player/next`
- `/api/player/previous` → POST `https://api.spotify.com/v1/me/player/previous`
- Controls the **active Spotify device**, without playing audio on the web

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SPOTIFY_CLIENT_ID` | Yes | Client ID of the Spotify app |
| `SPOTIFY_CLIENT_SECRET` | Yes | Client Secret of the Spotify app |
| `PORT` | No | Server port (default: 3000) |
| `BASE_URL` | No | Full external URL (e.g. `https://xxx.trycloudflare.com` or the Railway URL). Detected automatically when running locally. |
| `HOST` | No | Force a specific IP/hostname (default: detects local IP) |

## Known limitations

- **Spotify devices**: the Web API only reports playback if there's a visible "active device". If the music plays on a device with private session enabled, it won't be detected. If `api/player` returns `playing:false` while a song is playing, make sure **Private session** is disabled on the device.
- **Temporary URL**: the free Cloudflare Tunnel generates random URLs. For a permanent URL you'd need your own domain + authenticated Cloudflare Tunnel, or hosted on the cloud (Railway provides a permanent public URL).
- **Lyrics**: LRCLIB aggregates from multiple sources. Some songs may not have synchronized lyrics.
- **Tesla browser**: the Tesla browser is Chromium-based and works with HTTPS. It doesn't fully support the Web Audio API (that's why the controls use Spotify's Web API, not the Web Playback SDK).