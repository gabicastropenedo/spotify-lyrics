const $ = (sel) => document.querySelector(sel);

const els = {
  loginBtn: $('#login-btn'),
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

const POLL_INTERVAL = 1000; // cada 1s consulta al servidor para casi-tiempo real

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

// ---- Render de letras ----
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

// ---- Sincronización en tiempo real ----
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

// ---- Actualización de la UI con datos del servidor ----
function renderPlayer(data) {
  // No hay ninguna canción cargada (nada en reproducción en Spotify)
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

  // Hay canción (reproduciéndose o pausada): mantener todo visible
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
      setStatus('Sin letras sincronizadas para esta canción. 😔');
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
    // En reproducción: referencia viva para avanzar la letra en tiempo real.
    els.lyrics.dataset.startDate = String(performance.now() - data.progress_ms);
  } else {
    // Pausado: congelar el progreso para que la letra no siga avanzando.
    els.lyrics.dataset.pausedProgress = String(data.progress_ms);
  }
}

// ---- Polling al servidor ----
async function poll() {
  try {
    const response = await fetch('/api/player');
    if (response.status === 401) {
      // Sesión expirada / no autorizado
      location.reload();
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderPlayer(data);
  } catch (err) {
    console.error('Error consultando el servidor:', err);
  }
}

// ---- Control de reproducción (via Web API, sin audio en la web) ----
function setPlayState(playing) {
  isPlaying = playing;
  if (els.iconPlay && els.iconPause) {
    els.iconPlay.classList.toggle('hidden', playing);
    els.iconPause.classList.toggle('hidden', !playing);
  }
}

async function apiControl(endpoint) {
  try {
    const response = await fetch(endpoint, { method: 'POST' });
    if (response.status === 401) {
      location.reload();
      return;
    }
    if (response.status === 409) {
      setStatus('Reproduce algo en Spotify primero para poder controlarlo. 🎧');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    clearStatus();
  } catch (err) {
    console.error('Error en el control:', err);
    setStatus('Falló el control del reproductor.');
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

// ---- Inicialización ----
async function init() {
  setupTheme();
  try {
    const statusResponse = await fetch('/api/status');
    const status = await statusResponse.json();

    if (status.authorized) {
      els.loginBtn.classList.add('hidden');
      showLoading(true);
      setupControls();
      poll();
      pollTimer = setInterval(poll, POLL_INTERVAL);
      // Animación de sincronización continua
      setInterval(updateSync, 100);
    } else {
      els.loginBtn.classList.remove('hidden');
      showNoTrack(true);
      els.loginBtn.textContent = 'Conectar con Spotify';
    }
  } catch (err) {
    console.error('Error al inicializar:', err);
    setStatus('No se pudo contactar al servidor. ¿Está corriendo?');
    showNoTrack(true);
  }
}

// El botón de login siempre va a /login (el servidor redirige a Spotify)
els.loginBtn.addEventListener('click', () => {
  window.location.href = '/login';
});

init();
