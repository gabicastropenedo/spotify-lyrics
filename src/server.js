import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import fs from 'fs';

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
  console.error('ERROR: Faltan SPOTIFY_CLIENT_ID o SPOTIFY_CLIENT_SECRET. Revisa el archivo .env');
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

// Persistencia de sesión (para sobrevivir a reinicios del servidor)
const SESSION_FILE = path.join(__dirname, '..', '.session.json');

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('No se pudo leer la sesión guardada:', err.message);
  }
  return null;
}

function saveSession(tokens) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(tokens, null, 2));
  } catch (err) {
    console.error('No se pudo guardar la sesión:', err.message);
  }
}

// Estado del usuario (persistido en disco)
let userTokens = loadSession();

function setUserTokens(tokens) {
  userTokens = tokens;
  if (tokens) {
    saveSession(tokens);
  } else {
    try { fs.unlinkSync(SESSION_FILE); } catch {}
  }
}

// Caché de letras por track (evita reconsultar en cada poll)
let lyricsCache = {}; // { trackId: { data, at } }

function buildAuthUrl() {
  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    show_dialog: 'false',
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}#STATE=${state}`;
}

// ---- Rutas de autenticación ----

app.get('/login', (req, res) => {
  res.redirect(buildAuthUrl());
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.status(400).send(`Error de autorización: ${error}. <a href="/login">Intentar de nuevo</a>`);
  }

  try {
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

    setUserTokens(tokenResponse.data);
    res.redirect('/');
  } catch (err) {
    console.error('Error al intercambiar el código:', err.response?.data || err.message);
    res.status(500).send('Error al obtener el token. <a href="/login">Intentar de nuevo</a>');
  }
});

// ---- Middleware ----

async function getAccessToken() {
  if (!userTokens) return null;
  const { access_token, refresh_token, expires_at } = userTokens;

  if (Date.now() < expires_at) {
    return access_token;
  }

  try {
    const refreshResponse = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        },
      }
    );

    userTokens.access_token = refreshResponse.data.access_token;
    userTokens.expires_at = Date.now() + refreshResponse.data.expires_in * 1000;
    saveSession(userTokens);
    return userTokens.access_token;
  } catch (err) {
    console.error('Error al refrescar el token:', err.response?.data || err.message);
    setUserTokens(null);
    return null;
  }
}

function requireAuth(req, res, next) {
  if (!userTokens) {
    return res.status(401).json({ error: 'not_authorized' });
  }
  next();
}

// ---- Letras (LRCLIB) ----
// LRCLIB es una biblioteca abierta y gratuita (sin API key ni registro) que
// agrega letras sincronizadas (formato LRC) desde múltiples fuentes. Es estable
// y no depende de secretos rotatorios de Spotify.
const LRCLIB_BASE = 'https://lrclib.net/api';

// Parsea una letra en formato LRC ("[mm:ss.xx] texto") a líneas con timestamp.
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

// Busca letras por nombre de canción/artista/álbum y duración.
async function fetchLyrics(track, userAccessToken) {
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

    // Primero usar letras sincronizadas (timestamps); fallback a las estáticas.
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
      console.error('LRCLIB rate-limit alcanzado.');
      return { synced: false, lines: [], error: 'rate_limited' };
    }
    console.error('Error obteniendo lyrics (LRCLIB):', err.response?.status || err.message);
    return { synced: false, lines: [], error: 'unavailable' };
  }
}

// ---- API ----

app.get('/api/status', (req, res) => {
  res.json({ authorized: !!userTokens });
});

app.get('/api/player', requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      return res.status(401).json({ error: 'not_authorized' });
    }

    const playerResponse = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // 204 = no hay canción en reproducción
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

    // Obtener letras (con caché por track para no repetir en cada poll)
    let lyricsData = lyricsCache[item.id];
    if (!lyricsData || Date.now() - lyricsData.at > 60 * 60 * 1000) {
      response.lyrics = await fetchLyrics(response.track, accessToken);
      lyricsCache[item.id] = { data: response.lyrics, at: Date.now() };
      // Limitar el crecimiento de la caché
      if (Object.keys(lyricsCache).length > 50) lyricsCache = {};
    } else {
      response.lyrics = lyricsData.data;
    }

    res.json(response);
  } catch (err) {
    if (err.response?.status === 401) {
      return res.status(401).json({ error: 'not_authorized' });
    }
    console.error('Error en /api/player:', err.response?.data || err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ---- Endpoints de control de reproducción (Web API) ----
// Controla el dispositivo Spotify donde esté sonando, SIN reproducir audio en la web.

app.post('/api/player/play', requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'not_authorized' });

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

app.post('/api/player/pause', requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'not_authorized' });

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

app.post('/api/player/next', requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'not_authorized' });

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

app.post('/api/player/previous', requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'not_authorized' });

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

app.put('/api/player/volume', requireAuth, async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return res.status(401).json({ error: 'not_authorized' });

    const volume = Math.max(0, Math.min(100, Number(req.query.volume)));
    if (Number.isNaN(volume)) {
      return res.status(400).json({ error: 'invalid_volume' });
    }

    await axios.put(
      `https://api.spotify.com/v1/me/player/volume?volume_percent=${volume}`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    res.json({ ok: true });
  } catch (err) {
    handlePlayerError(err, res);
  }
});

function handlePlayerError(err, res) {
  // 404 (NO_ACTIVE_DEVICE) o 403 => no hay dispositivo reproduciendo
  if (err.response?.status === 404 && err.response?.data?.error?.reason === 'NO_ACTIVE_DEVICE') {
    return res.status(409).json({ error: 'no_device' });
  }
  if (err.response?.status === 401) {
    return res.status(401).json({ error: 'not_authorized' });
  }
  console.error('Error en control reproductor:', err.response?.data || err.message);
  res.status(500).json({ error: 'server_error' });
}

app.listen(PORT, () => {
  console.log(`Servidor de Spotify Lyrics en: ${BASE_URL}`);
  console.log(`REDIRECT_URI para tu app de Spotify Dashboard: ${REDIRECT_URI}`);
});
