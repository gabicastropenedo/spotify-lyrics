import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const PORT = process.env.PORT || 3000;
const SCOPES =
  'user-read-playback-state user-read-currently-playing user-modify-playback-state';

// Determina la URL base de la app.
// - Si defines BASE_URL (p. ej. https://tu-app.onrender.com), se usa tal cual.
// - Si no, en local detecta la IP de red para poder registrarla en Spotify.
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const HOST = process.env.HOST || getLocalIP();
const BASE_URL = process.env.BASE_URL || `http://${HOST}:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET. Check the .env file');
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Lyrics cache per track (avoids re-querying on every poll). It's global because
// the lyrics of a song are the same for all users.
let lyricsCache = {}; // { trackId: { data, at } }

function buildAuthUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    show_dialog: 'true', // permitir elegir cuenta al conectar
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}#STATE=${state}`;
}

async function exchangeCode(code) {
  const tokenResponse = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      },
    }
  );
  return tokenResponse.data;
}

async function refreshAccessToken(refreshToken) {
  const tokenResponse = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      },
    }
  );
  return tokenResponse.data;
}

// ---- Auth routes (multi-tenant: each user stores their own tokens) ----

// Returns the authorization URL for the frontend to redirect the user
app.get('/api/auth-url', (req, res) => {
  res.json({ url: buildAuthUrl() });
});

// Spotify redirects here after consent. Exchanges the code for tokens
// and returns a minimal HTML page that stores the tokens in the browser's
// localStorage and then redirects to the app. The refresh token never
// appears in the URL history.
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }

  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch (err) {
    console.error('Error exchanging the code:', err.response?.data || err.message);
    return res.redirect('/?error=auth_error');
  }

  const access_token = tokens.access_token || '';
  const refresh_token = tokens.refresh_token || '';
  const expires_in = (Number(tokens.expires_in) || 3600) * 1000;

  const html = `<!DOCTYPE html><html><body><script>
    try {
      localStorage.setItem('spotify_access_token', ${JSON.stringify(access_token)});
      localStorage.setItem('spotify_refresh_token', ${JSON.stringify(refresh_token)});
      localStorage.setItem('spotify_expires_at', String(Date.now() + ${expires_in}));
    } catch (e) {}
    location.replace('/');
  </script></body></html>`;
  res.send(html);
});

// Given a refresh_token, returns a new access token (to refresh the session)
app.post('/api/token', async (req, res) => {
  const refresh = req.headers['x-refresh-token'];
  if (!refresh) {
    return res.status(400).json({ error: 'missing_refresh_token' });
  }
  try {
    const data = await refreshAccessToken(refresh);
    res.json({
      access_token: data.access_token,
      expires_in: (Number(data.expires_in) || 3600) * 1000,
    });
  } catch (err) {
    if (err.response?.status === 400 || err.response?.status === 401) {
      return res.status(401).json({ error: 'invalid_refresh_token' });
    }
    console.error('Error refreshing token:', err.response?.data || err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---- Lyrics (LRCLIB) ----
// LRCLIB is an open, free library (no API key or signup) that aggregates
// synchronized lyrics (LRC format) from multiple sources. It's stable
// and doesn't depend on rotating Spotify secrets.
const LRCLIB_BASE = 'https://lrclib.net/api';

// Parses lyrics in LRC format ("[mm:ss.xx] text") into lines with timestamps.
function parseLRC(lrc) {
  const lines = [];
  const lineRegex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)/;
  for (const raw of lrc.split('\n')) {
    const match = raw.match(lineRegex);
    if (!match) continue;
    const [, mm, ss, frac] = match;
    let ms = parseInt(mm, 10) * 60000 + parseInt(ss, 10) * 1000;
    if (frac) {
      ms += parseInt(frac.padEnd(3, '0').slice(0, 3), 10);
    }
    lines.push({ startTimeMs: ms, text: match[4].trim() });
  }
  return lines;
}

// Looks up lyrics by song/artist/album name and duration.
async function fetchLyrics(track) {
  try {
    const params = new URLSearchParams({
      track_name: track.name,
      artist_name: track.artists,
    });
    if (track.album) params.set('album_name', track.album);
    if (track.duration_ms) params.set('duration', String(Math.round(track.duration_ms / 1000)));

    const { data } = await axios.get(`${LRCLIB_BASE}/get?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 8000,
    });

    const synced = data?.syncedLyrics || null;
    const plain = data?.plainLyrics || null;
    if (!synced && !plain) {
      return { synced: false, lines: [], error: 'no_lyrics' };
    }

    if (synced) {
      const lines = parseLRC(synced);
      if (lines.length) {
        return { synced: true, syncType: 'LINE_SYNCED', lines };
      }
    }

    const lines = (plain || '').split('\n').map((text) => ({ startTimeMs: null, text: text.trim() })).filter((l) => l.text);
    return { synced: false, syncType: 'UNSYNCED', lines };
  } catch (err) {
    if (err.response?.status === 404) {
      return { synced: false, lines: [], error: 'no_lyrics' };
    }
    if (err.response?.status === 429) {
      console.error('LRCLIB rate limit reached.');
      return { synced: false, lines: [], error: 'rate_limited' };
    }
    console.error('Error fetching lyrics (LRCLIB):', err.response?.status || err.message);
    return { synced: false, lines: [], error: 'unavailable' };
  }
}

// ---- Auth middleware by user token ----
// The browser sends the user's access_token in the Authorization header.
function getBearerToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7);
  }
  return null;
}

// ---- API ----

app.get('/api/status', (req, res) => {
  // The app is always "ready"; the frontend decides when there's a session (localStorage).
  res.json({ ok: true });
});

app.get('/api/player', async (req, res) => {
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    return res.status(401).json({ error: 'not_authorized' });
  }

  try {
    const playerResponse = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // 204 = no song currently playing
    if (!playerResponse.data || !playerResponse.data.item) {
      return res.json({ playing: false });
    }

    const item = playerResponse.data.item;
    const response = {
      playing: playerResponse.data.is_playing,
      progress_ms: playerResponse.data.progress_ms || 0,
      track: {
        id: item.id,
        name: item.name,
        duration_ms: item.duration_ms,
        artists: item.artists.map((a) => a.name).join(', '),
        album: item.album?.name,
        cover: item.album?.images?.[0]?.url || null,
      },
    };

    // Get lyrics (with per-track cache to avoid re-querying on every poll)
    let lyricsData = lyricsCache[item.id];
    if (!lyricsData || Date.now() - lyricsData.at > 60 * 60 * 1000) {
      response.lyrics = await fetchLyrics(response.track);
      lyricsCache[item.id] = { data: response.lyrics, at: Date.now() };
      if (Object.keys(lyricsCache).length > 50) lyricsCache = {};
    } else {
      response.lyrics = lyricsData.data;
    }

    res.json(response);
  } catch (err) {
    if (err.response?.status === 401) {
      return res.status(401).json({ error: 'not_authorized' });
    }
    console.error('Error in /api/player:', err.response?.data || err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---- Playback control endpoints (Web API) ----
// Controls the Spotify device where the music is playing, WITHOUT playing audio on the web.

app.post('/api/player/play', async (req, res) => {
  const accessToken = getBearerToken(req);
  if (!accessToken) return res.status(401).json({ error: 'not_authorized' });

  try {
    await axios.put(
      'https://api.spotify.com/v1/me/player/play',
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    res.json({ ok: true });
  } catch (err) {
    handlePlayerError(err, res);
  }
});

app.post('/api/player/pause', async (req, res) => {
  const accessToken = getBearerToken(req);
  if (!accessToken) return res.status(401).json({ error: 'not_authorized' });

  try {
    await axios.put(
      'https://api.spotify.com/v1/me/player/pause',
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    res.json({ ok: true });
  } catch (err) {
    handlePlayerError(err, res);
  }
});

app.post('/api/player/next', async (req, res) => {
  const accessToken = getBearerToken(req);
  if (!accessToken) return res.status(401).json({ error: 'not_authorized' });

  try {
    await axios.post(
      'https://api.spotify.com/v1/me/player/next',
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    res.json({ ok: true });
  } catch (err) {
    handlePlayerError(err, res);
  }
});

app.post('/api/player/previous', async (req, res) => {
  const accessToken = getBearerToken(req);
  if (!accessToken) return res.status(401).json({ error: 'not_authorized' });

  try {
    await axios.post(
      'https://api.spotify.com/v1/me/player/previous',
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    res.json({ ok: true });
  } catch (err) {
    handlePlayerError(err, res);
  }
});

function handlePlayerError(err, res) {
  if (err.response?.status === 404 && err.response?.data?.error?.reason === 'NO_ACTIVE_DEVICE') {
    return res.status(409).json({ error: 'no_device' });
  }
  if (err.response?.status === 401) {
    return res.status(401).json({ error: 'not_authorized' });
  }
  console.error('Error in player controls:', err.response?.data || err.message);
  res.status(500).json({ error: 'server_error' });
}

app.listen(PORT, () => {
  console.log(`Spotify Lyrics server running at: ${BASE_URL}`);
  console.log(`REDIRECT_URI for your Spotify Dashboard app: ${REDIRECT_URI}`);
});
