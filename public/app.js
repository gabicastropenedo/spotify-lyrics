const $ = (sel) => document.querySelector(sel);

const els = {
  loginBtn: $('#login-btn'),
  logoutBtn: $('#logout-btn'),
  status: $('#status'),
  themeToggle: $('#theme-toggle'),
  iconSun: $('#icon-sun'),
  iconMoon: $('#icon-moon'),
  nowPlaying: $('#now-playing'),
  cover: $('#cover'),
  trackName: $('#track-name'),
  trackArtist: $('#track-artist'),
  progressLine: $('#progress-line'),
  progressTime: $('#progress-time'),
  lyrics: $('#lyrics'),
  noTrack: $('#no-track-message'),
  loading: $('#loading-message'),
  playBtn: $('#btn-play'),
  nextBtn: $('#btn-next'),
  prevBtn: $('#btn-prev'),
  iconPlay: $('#icon-play'),
  iconPause: $('#icon-pause'),
};

// Estado local
let currentTrackId = null;
let menuLines = [];      // [{ text, startTimeMs }]
let isSynced = false;
let pollTimer = null;
let isPlaying = false;

const POLL_INTERVAL = 1000; // poll the server every 1s for near-real-time updates

// ---- Session management (user tokens in localStorage) ----
function hasSession() {
  return !!localStorage.getItem('spotify_refresh_token');
}

function clearSession() {
  localStorage.removeItem('spotify_access_token');
  localStorage.removeItem('spotify_refresh_token');
  localStorage.removeItem('spotify_expires_at');
}

// Returns a valid access token, refreshing it when expired.
async function getAccessToken() {
  const access = localStorage.getItem('spotify_access_token');
  const refresh = localStorage.getItem('spotify_refresh_token');
  const expiresAt = Number(localStorage.getItem('spotify_expires_at') || 0);

  if (access && refresh && Date.now() < expiresAt - 30000) {
    return access;
  }

  if (!refresh) {
    return null;
  }

  // Pedir un access token nuevo usando el refresh token
  try {
    const response = await fetch('/api/token', {
      method: 'POST',
      headers: { 'x-refresh-token': refresh },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    localStorage.setItem('spotify_access_token', data.access_token);
    localStorage.setItem('spotify_expires_at', String(Date.now() + data.expires_in));
    return data.access_token;
  } catch (err) {
    console.error('Error refreshing token:', err);
    clearSession();
    return null;
  }
}

function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setStatus(msg) {
  els.status.textContent = msg;
  els.status.classList.remove('hidden');
}

function clearStatus() {
  els.status.classList.add('hidden');
}

function showNoTrack(show) {
  els.noTrack.classList.toggle('hidden', !show);
}

function showLoading(show) {
  els.loading.classList.toggle('hidden', !show);
}

// ---- Lyrics render ----
function renderLyrics(lines) {
  els.lyrics.innerHTML = '';
  lines.forEach((line, i) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.dataset.index = i;
    div.textContent = line.text || '\u00A0';
    els.lyrics.appendChild(div);
  });
}

// ---- Real-time sync ----
function updateSync() {
  const lyricEls = els.lyrics.querySelectorAll('.lyric-line');
  if (!isSynced || lyricEls.length === 0) return;

  let elapsed;
  if (isPlaying) {
    const startDate = els.lyrics.dataset.startDate;
    if (!startDate) return;
    elapsed = performance.now() - parseFloat(startDate);
  } else {
    // Pausado: usar el progreso congelado para no seguir avanzando.
    const paused = els.lyrics.dataset.pausedProgress;
    if (paused == null) return;
    elapsed = parseFloat(paused);
  }
  let activeIndex = -1;

  for (let i = 0; i < menuLines.length; i++) {
    const t = menuLines[i].startTimeMs;
    if (t != null && elapsed >= t) {
      activeIndex = i;
    } else if (t != null && elapsed < t) {
      break;
    }
  }

  lyricEls.forEach((el, i) => {
    el.classList.toggle('active', i === activeIndex);
    el.classList.toggle('sung', isSynced && activeIndex >= 0 && i < activeIndex);
  });

  if (activeIndex >= 0) {
    const active = lyricEls[activeIndex];
    const container = els.lyrics;
    const containerMid = container.clientHeight / 2;
    const activeTop = active.offsetTop - container.offsetTop;
    container.scrollTo({
      top: activeTop - containerMid + active.clientHeight / 2,
      behavior: 'smooth',
    });
  }
}

// ---- UI updates with server data ----
function renderPlayer(data) {
  // No song currently loaded (nothing playing on Spotify)
  if (!data.track) {
    els.nowPlaying.classList.add('hidden');
    showNoTrack(true);
    showLoading(false);
    els.lyrics.innerHTML = '';
    menuLines = [];
    isSynced = false;
    currentTrackId = null;
    setPlayState(false);
    return;
  }

  // There is a song (playing or paused): keep everything visible
  const track = data.track;
  const trackChanged = track.id !== currentTrackId;

  els.nowPlaying.classList.remove('hidden');
  showNoTrack(false);
  showLoading(false);
  setPlayState(data.playing);

  els.cover.src = track.cover || '';
  els.trackName.textContent = track.name;
  els.trackArtist.textContent = track.artists;

  if (trackChanged) {
    currentTrackId = track.id;

    menuLines = data.lyrics?.lines || [];
    isSynced = !!data.lyrics?.synced;

    if (menuLines.length === 0) {
      els.lyrics.innerHTML = '';
      setStatus('No synced lyrics found for this song. 😔');
    } else {
      clearStatus();
      renderLyrics(menuLines);
      els.lyrics.scrollTop = 0;
    }
  }

  // Barra de progreso
  const pct = track.duration_ms ? (data.progress_ms / track.duration_ms) * 100 : 0;
  els.progressLine.style.setProperty('--pct', `${Math.min(100, pct)}%`);
  els.progressTime.textContent = `${formatTime(data.progress_ms)} / ${formatTime(track.duration_ms)}`;

  if (data.playing) {
    // Playing: live reference to advance the lyrics in real time.
    els.lyrics.dataset.startDate = String(performance.now() - data.progress_ms);
  } else {
    // Pausado: congelar el progreso para que la letra no siga avanzando.
    els.lyrics.dataset.pausedProgress = String(data.progress_ms);
  }
}

// ---- Polling al servidor ----
async function poll() {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    showLoggedOut();
    return;
  }
  try {
    const response = await fetch('/api/player', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401) {
      clearSession();
      showLoggedOut();
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderPlayer(data);
  } catch (err) {
    console.error('Error querying the server:', err);
  }
}

// ---- Playback controls (Web API, no audio on the web) ----
function setPlayState(playing) {
  isPlaying = playing;
  if (els.iconPlay && els.iconPause) {
    els.iconPlay.classList.toggle('hidden', playing);
    els.iconPause.classList.toggle('hidden', !playing);
  }
}

async function apiControl(endpoint) {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    showLoggedOut();
    return;
  }
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 401) {
      clearSession();
      showLoggedOut();
      return;
    }
    if (response.status === 409) {
      setStatus('Play something on Spotify first to control it. 🎧');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    clearStatus();
  } catch (err) {
    console.error('Error in control:', err);
    setStatus('Could not control the player.');
  }
}

function setupControls() {
  els.playBtn.addEventListener('click', () => {
    apiControl(isPlaying ? '/api/player/pause' : '/api/player/play');
  });
  els.nextBtn.addEventListener('click', () => apiControl('/api/player/next'));
  els.prevBtn.addEventListener('click', () => apiControl('/api/player/previous'));
}

// ---- Tema claro/oscuro (estilo Tesla) ----
function setupTheme() {
  const stored = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = stored || (prefersDark ? 'dark' : 'light');
  applyTheme(theme);

  els.themeToggle.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  if (els.iconSun && els.iconMoon) {
    els.iconSun.classList.toggle('hidden', theme !== 'light');
    els.iconMoon.classList.toggle('hidden', theme !== 'dark');
  }
}

// ---- UI states by session ----
function showLoggedIn() {
  els.loginBtn.classList.add('hidden');
  els.logoutBtn.classList.remove('hidden');
  clearStatus();
}

function showLoggedOut() {
  stopPolling();
  els.loginBtn.classList.remove('hidden');
  els.logoutBtn.classList.add('hidden');
  els.nowPlaying.classList.add('hidden');
  els.lyrics.innerHTML = '';
  menuLines = [];
  isSynced = false;
  currentTrackId = null;
  showLoading(false);
  showNoTrack(true);
  els.noTrack.textContent = 'Connect your Spotify account to see your lyrics.';
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ---- Initialization ----
async function init() {
  setupTheme();

  // Connect button: fetch the auth URL and redirect
  els.loginBtn.addEventListener('click', async () => {
    try {
      const response = await fetch('/api/auth-url');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      window.location.href = data.url;
    } catch (err) {
      console.error('Error getting auth URL:', err);
      setStatus('Could not start the Spotify connection.');
    }
  });

  // Logout button
  els.logoutBtn.addEventListener('click', () => {
    clearSession();
    showLoggedOut();
  });

  // Si el usuario viene del callback con error, mostrarlo
  const params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    const error = params.get('error');
    const msg = error === 'auth_error' ? 'Could not sign in. Try again.' : 'Authorization cancelled or failed.';
    setStatus(msg);
    window.history.replaceState({}, '', window.location.pathname);
  }

  if (!hasSession()) {
    showLoggedOut();
    return;
  }

  // Session saved: start the player
  showLoggedIn();
  setupControls();
  showLoading(true);
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL);
  setInterval(updateSync, 100);
}

document.addEventListener('DOMContentLoaded', init);
