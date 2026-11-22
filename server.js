import crypto from 'node:crypto'
import path from 'node:path'
import express from 'express'
import postgres from 'postgres'
import QRCode from 'qrcode'

const PORT = Number(process.env.PORT || 3000)
const VERCEL_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
const BASE_URL = (process.env.BASE_URL || VERCEL_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '')
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const ACCOUNTS_URL = process.env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com'
const API_URL = process.env.SPOTIFY_API_URL || 'https://api.spotify.com/v1'
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL
const SCOPES = 'playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private'
const SECURE_COOKIES = BASE_URL.startsWith('https://')

if (!CLIENT_ID || !CLIENT_SECRET) console.error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are not set; Spotify login is disabled (see README.md).')
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL to a Postgres connection string (see README.md).')
  process.exit(1)
}

// Timestamps are milliseconds since the epoch, stored as DOUBLE PRECISION so they come back as JS numbers.
const sql = postgres(DATABASE_URL, { onnotice: () => {} })
await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at DOUBLE PRECISION NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES hosts(id)
  );
  CREATE TABLE IF NOT EXISTS parties (
    code TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES hosts(id),
    playlist_id TEXT NOT NULL,
    playlist_name TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
  );
  CREATE TABLE IF NOT EXISTS suggestions (
    id SERIAL PRIMARY KEY,
    party_code TEXT NOT NULL REFERENCES parties(code) ON DELETE CASCADE,
    track_uri TEXT NOT NULL,
    track_name TEXT NOT NULL,
    artists TEXT NOT NULL,
    image TEXT,
    guest_id TEXT NOT NULL,
    guest_name TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DOUBLE PRECISION NOT NULL
  );
`)

const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url')
const partyCode = () => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('')
}

// ---------- Spotify ----------

class SpotifyError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function tokenRequest(params) {
  const res = await fetch(`${ACCOUNTS_URL}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams(params),
  })
  const body = await res.json()
  if (!res.ok) throw new SpotifyError(res.status, body.error_description || body.error || 'Spotify login failed')
  return body
}

async function accessTokenFor(hostId) {
  const [host] = await sql`SELECT * FROM hosts WHERE id = ${hostId}`
  if (host.expires_at > Date.now() + 60_000) return host.access_token
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: host.refresh_token })
  await sql`
    UPDATE hosts SET access_token = ${t.access_token}, refresh_token = ${t.refresh_token || host.refresh_token},
      expires_at = ${Date.now() + t.expires_in * 1000}
    WHERE id = ${hostId}`
  return t.access_token
}

async function spotify(hostId, method, endpoint, body) {
  const res = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessTokenFor(hostId)}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  })
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    const message =
      res.status === 429 ? 'Spotify is rate limiting requests. Try again in a minute.' : data?.error?.message || `Spotify error ${res.status}`
    throw new SpotifyError(res.status, message)
  }
  return data
}

// ---------- App ----------

const app = express()
app.use(express.json())
app.use(express.static('public', { index: false }))

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=')
        return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]
      }),
  )
}

function setCookie(res, name, value, maxAgeSeconds) {
  res.append(
    'Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${SECURE_COOKIES ? '; Secure' : ''}`,
  )
}

async function currentHost(req) {
  const sid = cookies(req).sid
  if (!sid) return null
  const [host] = await sql`SELECT hosts.id, hosts.name FROM sessions JOIN hosts ON hosts.id = sessions.host_id WHERE sessions.id = ${sid}`
  return host ?? null
}

async function requireHost(req, res, next) {
  req.user = await currentHost(req)
  if (!req.user) return res.status(401).json({ error: 'Log in with Spotify first.' })
  next()
}

async function ownParty(req, res, next) {
  ;[req.party] = await sql`SELECT * FROM parties WHERE code = ${req.params.code} AND host_id = ${req.user.id}`
  if (!req.party) return res.status(404).json({ error: 'Party not found.' })
  next()
}

function guestId(req, res) {
  let id = cookies(req).guest
  if (!id) {
    id = randomId(16)
    setCookie(res, 'guest', id, 60 * 60 * 24 * 365)
  }
  return id
}

const page = (file) => (req, res) => res.sendFile(path.resolve('public', file))

// Pages
app.get('/', page('index.html'))
app.get('/host/:code', page('host.html'))
app.get('/p/:code', page('guest.html'))

// Spotify login for the host
app.get('/login', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.redirect(`/?error=${encodeURIComponent('Spotify is not set up yet: add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (see README.md).')}`)
  }
  const state = randomId(16)
  setCookie(res, 'oauth_state', state, 600)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: `${BASE_URL}/callback`,
    state,
  })
  res.redirect(`${ACCOUNTS_URL}/authorize?${params}`)
})

app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error || !code || !state || state !== cookies(req).oauth_state) {
    return res.redirect(`/?error=${encodeURIComponent(error || 'Login was cancelled or expired. Try again.')}`)
  }
  setCookie(res, 'oauth_state', '', 0)
  let t
  try {
    t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: `${BASE_URL}/callback` })
  } catch (err) {
    return res.redirect(`/?error=${encodeURIComponent(`Spotify login failed: ${err.message}`)}`)
  }
  const meRes = await fetch(`${API_URL}/me`, { headers: { Authorization: `Bearer ${t.access_token}` } })
  if (!meRes.ok) {
    const message =
      meRes.status === 403
        ? 'Spotify refused access. Add your account under User Management in your Spotify developer app.'
        : `Spotify error ${meRes.status}`
    return res.redirect(`/?error=${encodeURIComponent(message)}`)
  }
  const me = await meRes.json()
  await sql`
    INSERT INTO hosts (id, name, access_token, refresh_token, expires_at)
    VALUES (${me.id}, ${me.display_name || me.id}, ${t.access_token}, ${t.refresh_token}, ${Date.now() + t.expires_in * 1000})
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, access_token = excluded.access_token,
      refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`
  const sid = randomId()
  await sql`INSERT INTO sessions (id, host_id) VALUES (${sid}, ${me.id})`
  setCookie(res, 'sid', sid, 60 * 60 * 24 * 90)
  res.redirect('/')
})

app.post('/logout', async (req, res) => {
  await sql`DELETE FROM sessions WHERE id = ${cookies(req).sid ?? ''}`
  setCookie(res, 'sid', '', 0)
  res.json({ ok: true })
})

// Host API
app.get('/api/me', async (req, res) => res.json({ host: await currentHost(req) }))

app.get('/api/playlists', requireHost, async (req, res) => {
  const playlists = []
  for (let offset = 0; offset < 500; offset += 50) {
    const pageData = await spotify(req.user.id, 'GET', `/me/playlists?limit=50&offset=${offset}`)
    for (const p of pageData.items) {
      if (!p || (p.owner?.id !== req.user.id && !p.collaborative)) continue
      playlists.push({ id: p.id, name: p.name, image: p.images?.at(-1)?.url ?? null, total: p.items?.total ?? p.tracks?.total ?? null })
    }
    if (!pageData.next) break
  }
  res.json({ playlists })
})

app.get('/api/parties', requireHost, async (req, res) => {
  const parties = await sql`
    SELECT code, playlist_name, created_at,
      (SELECT COUNT(*)::int FROM suggestions s WHERE s.party_code = parties.code AND s.status = 'pending') AS pending
    FROM parties WHERE host_id = ${req.user.id} ORDER BY created_at DESC`
  res.json({ parties })
})

app.post('/api/parties', requireHost, async (req, res) => {
  let { playlistId, newPlaylistName } = req.body
  let playlistName
  if (newPlaylistName?.trim()) {
    const p = await spotify(req.user.id, 'POST', '/me/playlists', {
      name: newPlaylistName.trim().slice(0, 100),
      description: 'Songs suggested by party guests',
      public: false,
    })
    playlistId = p.id
    playlistName = p.name
  } else if (playlistId) {
    const p = await spotify(req.user.id, 'GET', `/playlists/${encodeURIComponent(playlistId)}?fields=id,name`)
    playlistName = p.name
  } else {
    return res.status(400).json({ error: 'Pick a playlist or name a new one.' })
  }
  const code = partyCode()
  await sql`
    INSERT INTO parties (code, host_id, playlist_id, playlist_name, created_at)
    VALUES (${code}, ${req.user.id}, ${playlistId}, ${playlistName}, ${Date.now()})`
  res.json({ code })
})

app.get('/api/parties/:code', requireHost, ownParty, async (req, res) => {
  const suggestions = await sql`
    SELECT id, track_uri, track_name, artists, image, guest_name, status, created_at
    FROM suggestions WHERE party_code = ${req.party.code} ORDER BY created_at`
  res.json({
    party: { code: req.party.code, playlistId: req.party.playlist_id, playlistName: req.party.playlist_name, guestUrl: `${BASE_URL}/p/${req.party.code}` },
    suggestions,
  })
})

app.delete('/api/parties/:code', requireHost, ownParty, async (req, res) => {
  await sql`DELETE FROM parties WHERE code = ${req.party.code}`
  res.json({ ok: true })
})

app.get('/api/parties/:code/qr.svg', requireHost, ownParty, async (req, res) => {
  const svg = await QRCode.toString(`${BASE_URL}/p/${req.party.code}`, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })
  res.type('image/svg+xml').send(svg)
})

app.post('/api/parties/:code/suggestions/:id/:decision', requireHost, ownParty, async (req, res) => {
  const { decision } = req.params
  if (decision !== 'approve' && decision !== 'reject') return res.status(404).json({ error: 'Unknown action.' })
  const id = Number(req.params.id)
  const [s] = Number.isSafeInteger(id) ? await sql`SELECT * FROM suggestions WHERE id = ${id} AND party_code = ${req.party.code}` : []
  if (!s) return res.status(404).json({ error: 'Suggestion not found.' })
  if (s.status !== 'pending') return res.json({ status: s.status })
  if (decision === 'approve') {
    await spotify(req.user.id, 'POST', `/playlists/${encodeURIComponent(req.party.playlist_id)}/items`, { uris: [s.track_uri] })
  }
  const status = decision === 'approve' ? 'approved' : 'rejected'
  await sql`UPDATE suggestions SET status = ${status} WHERE id = ${s.id}`
  res.json({ status })
})

// Guest API (no Spotify login; searches run with the host's account)
async function findParty(req, res, next) {
  ;[req.party] = await sql`SELECT * FROM parties WHERE code = ${req.params.code}`
  if (!req.party) return res.status(404).json({ error: 'This party link is no longer active.' })
  next()
}

app.get('/api/p/:code', findParty, async (req, res) => {
  const mine = await sql`
    SELECT id, track_name, artists, image, status FROM suggestions
    WHERE party_code = ${req.party.code} AND guest_id = ${guestId(req, res)} ORDER BY created_at DESC`
  const [host] = await sql`SELECT name FROM hosts WHERE id = ${req.party.host_id}`
  res.json({ playlistName: req.party.playlist_name, hostName: host.name, mine })
})

app.get('/api/p/:code/search', findParty, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100)
  if (!q) return res.json({ tracks: [] })
  const data = await spotify(req.party.host_id, 'GET', `/search?type=track&limit=10&q=${encodeURIComponent(q)}`)
  res.json({
    tracks: data.tracks.items.map((t) => ({
      uri: t.uri,
      name: t.name,
      artists: t.artists.map((a) => a.name).join(', '),
      album: t.album?.name,
      image: t.album?.images?.at(-1)?.url ?? null,
      explicit: t.explicit,
    })),
  })
})

app.post('/api/p/:code/suggestions', findParty, async (req, res) => {
  const { uri, name, artists, image, guestName } = req.body
  if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(uri || '') || !name) return res.status(400).json({ error: 'Pick a song from the search results.' })
  const gid = guestId(req, res)
  const [existing] = await sql`
    SELECT status FROM suggestions WHERE party_code = ${req.party.code} AND track_uri = ${uri} AND status != 'rejected'`
  if (existing) {
    return res.status(409).json({ error: existing.status === 'approved' ? "That song's already on the playlist." : 'Someone already suggested that song.' })
  }
  const [{ pending }] = await sql`
    SELECT COUNT(*)::int AS pending FROM suggestions
    WHERE party_code = ${req.party.code} AND guest_id = ${gid} AND status = 'pending'`
  if (pending >= 10) return res.status(429).json({ error: 'You have 10 songs waiting for approval. Try again after the host reviews them.' })
  await sql`
    INSERT INTO suggestions (party_code, track_uri, track_name, artists, image, guest_id, guest_name, created_at)
    VALUES (${req.party.code}, ${uri}, ${String(name).slice(0, 200)}, ${String(artists || '').slice(0, 200)},
      ${typeof image === 'string' && image.startsWith('https://') ? image : null}, ${gid},
      ${String(guestName || '').trim().slice(0, 40) || null}, ${Date.now()})`
  res.json({ ok: true })
})

app.use((err, req, res, next) => {
  console.error(err)
  const status = err instanceof SpotifyError ? (err.status === 401 ? 502 : err.status) : 500
  res.status(status).json({ error: err instanceof SpotifyError ? err.message : 'Something went wrong.' })
})

app.listen(PORT, () => {
  console.log(`Spotify Party running on port ${PORT}`)
  console.log(`Public URL: ${BASE_URL} (Spotify redirect URI: ${BASE_URL}/callback)`)
})
