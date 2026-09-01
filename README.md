# Spotify Lyrics — Letras en tiempo real para Tesla

Reproductor web de Spotify que muestra letras sincronizadas en tiempo real con controles de play/pause, diseñado para usarse desde el navegador del Tesla.

## Arquitectura

```
spotify-lyrics/
├── src/
│   └── server.js        # Backend Express (auth + proxy Spotify + letras LRCLIB)
├── public/
│   ├── index.html        # UI principal
│   ├── style.css         # Estilos (tema Tesla oscuro/claro)
│   ├── app.js            # Lógica frontend (polling, sync, controles)
│   └── favicon.svg       # Icono del proyecto
├── .env                  # Credenciales (no commitear)
├── .env.example          # Plantilla de .env
├── .session.json         # Token de sesión persistido (no commitear)
└── package.json          # Dependencias: express, axios, dotenv
```

## Stack

- **Backend**: Node.js + Express, Authorization Code Flow de Spotify
- **Frontend**: HTML/CSS/JS vanilla (sin framework)
- **Letras**: API de LRCLIB (gratis, abierta, sin API key — https://lrclib.net)
- **Expose local**: Cloudflare Tunnel (cloudflared) para acceso HTTPS desde el Tesla

## Dependencias

```bash
npm install   # Instala express, axios, dotenv (84 paquetes)
```

## Configuración

### 1. Crear app en Spotify Developer Dashboard

1. Ir a https://developer.spotify.com/dashboard
2. Crear app → nombre libre
3. En **Edit Settings → Redirect URIs** añadir la URL de callback:
   - Local: `http://127.0.0.1:3000/callback` (obligatorio usar `127.0.0.1`, NO `localhost`)
   - Remoto (Cloudflare Tunnel): `https://<tu-url>.trycloudflare.com/callback`
4. Copiar **Client ID** y **Client Secret**

### 2. Crear `.env`

```bash
cp .env.example .env
```

Rellenar con las credenciales:
```
SPOTIFY_CLIENT_ID=eb67925702774745b03858956b041bb5
SPOTIFY_CLIENT_SECRET=dd9bf1bd7088410b80dcda7e27984892
PORT=3000
```

## Ejecutar en local

```bash
node src/server.js
```

- Servidor en http://127.0.0.1:3000
- Abrir en navegador, hacer login con Spotify
- La sesión se guarda en `.session.json` (sobrevive reinicios del servidor)

## Exponer para el Tesla (Cloudflare Tunnel)

1. Descargar cloudflared: https://developers.cloudflare.com/tunnel/downloads/
2. Guardar el ejecutable en una carpeta estable
3. Arrancar el túnel:

```bash
cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate
```

4. Copiar la URL `https://xxx.trycloudflare.com` que aparece
5. Si es la primera vez: registrar la URL como redirect en Spotify Dashboard
6. Abrir la URL en el navegador del Tesla

**Nota**: la URL de trycloudflare.com es temporal y cambia al reiniciar cloudflared. La sesión del servidor persiste, así que si ya autorizaste antes, las letras funcionan sin re-autenticar.

Para cerrar:
- `Get-Process node,cloudflared | Stop-Process -Force`

## Cómo funciona

### Auth (server.js)

- Authorization Code Flow con scopes: `user-read-playback-state`, `user-read-currently-playing`, `user-modify-playback-state`
- El refresh token no expira → una vez autenticado, no necesita re-login
- Token de acceso se renueva automáticamente vía refresh

### Letras (LRCLIB)

- API gratuita y abierta: `https://lrclib.net/api/get?track_name=...&artist_name=...&album_name=...&duration=...`
- Devuelve `syncedLyrics` (formato LRC con timestamps) o `plainLyrics`
- El parser `parseLRC()` convierte LRC a `{startTimeMs, text}`
- Caché de 60 minutos por trackId para no reconsultar en cada poll
- Se busca por nombre de canción + artista + álbum + duración (no por ID de Spotify)

### Frontend (app.js)

- Polling cada 1 segundo a `/api/player`
- `updateSync()` corre cada 100ms calculando la línea activa con `performance.now() - startDate`
- Cuando está pausado, se congela el progreso en `pausedProgress` (la letra no avanza)
- Tema Tesla: `html[data-theme="dark"]` / `html[data-theme="light"]` con paleta oficial Tesla
  - Oscuro: fondo `#000000`, surface `#171A20`, texto `#FFFFFF`
  - Claro: fondo `#FFFFFF`, surface `#F4F4F4`, texto `#171A20`
- Persistencia del tema en `localStorage`
- Iconos SVG inline (prev/play/next) minimalistas sin acento de color

### Controles

- `/api/player/play` → PUT `https://api.spotify.com/v1/me/player/play`
- `/api/player/pause` → PUT `https://api.spotify.com/v1/me/player/pause`
- `/api/player/next` → POST `https://api.spotify.com/v1/me/player/next`
- `/api/player/previous` → POST `https://api.spotify.com/v1/me/player/previous`
- Controla el **dispositivo activo** de Spotify, SIN reproducir audio en la web

## Variables de entorno

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `SPOTIFY_CLIENT_ID` | Sí | Client ID de la app Spotify |
| `SPOTIFY_CLIENT_SECRET` | Sí | Client Secret de la app Spotify |
| `PORT` | No | Puerto del servidor (default: 3000) |
| `BASE_URL` | No | URL externa completa (ej: `https://xxx.trycloudflare.com`). En local se detecta automáticamente. |
| `HOST` | No | Forzar IP/hostname concreto (default: detecta IP local) |

## Limitaciones conocidas

- **Dispositivos Spotify**: la Web API solo reporta reproducción si hay un "device activo" visible. Si la música suena en un dispositivo sin sesión privada, debería funcionar. Si `api/player` devuelve `playing:false` con canción sonando, verificar que **Sesión privada** esté desactivada en el dispositivo.
- **URL temporal**: Cloudflare Tunnel gratuito genera URLs aleatorias. Para URL permanente se necesitaría un dominio propio + Cloudflare Tunnel autenticado, o hosting en la nube.
- **Letras**: LRCLIB agrega desde múltiples fuentes. Algunas canciones pueden no tener letras sincronizadas.
- **Tesla browser**: el navegador del Tesla es Chromium-based. Funciona con HTTPS. No soporta Web Audio API completa (por eso los controles usan la Web API de Spotify, no el Web Playback SDK).
