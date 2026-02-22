require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const os = require('os');

// ── Spotify credentials from .env ────────────────────────────────────────────
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3001/callback';

// In-memory token store (single-user local app)
let spotifyTokens = { access_token: null, refresh_token: null, expires_at: 0 };

/** Make a JSON request to Spotify API */
function spotifyRequest(method, endpoint, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL('https://api.spotify.com/v1' + endpoint);
    const options = {
      method,
      hostname: 'api.spotify.com',
      path: '/v1' + endpoint,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// Store connected clients
const connectedClients = new Map();
const rooms = new Map(); // roomId -> Set of socket IDs

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Handle client registration
  socket.on('register', (data) => {
    const { clientType, clientId, roomId } = data;
    console.log(`Client registered: ${clientType} - ${clientId} in room ${roomId}`);

    connectedClients.set(socket.id, {
      clientType,
      clientId,
      roomId,
      socket
    });

    // Join room
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId).add(socket.id);
    socket.join(roomId);

    // Notify others in the room
    socket.to(roomId).emit('client-joined', {
      clientType,
      clientId,
      socketId: socket.id
    });
  });

  // Handle WebRTC signaling messages
  socket.on('webrtc-offer', (data) => {
    const { targetId, offer, roomId } = data;
    console.log(`WebRTC offer from ${socket.id} to ${targetId} in room ${roomId}`);

    // Find target socket
    const targetClient = Array.from(connectedClients.values())
      .find(client => client.clientId === targetId && client.roomId === roomId);

    if (targetClient) {
      targetClient.socket.emit('webrtc-offer', {
        fromId: connectedClients.get(socket.id)?.clientId,
        offer,
        roomId
      });
    }
  });

  socket.on('webrtc-answer', (data) => {
    const { targetId, answer, roomId } = data;
    console.log(`WebRTC answer from ${socket.id} to ${targetId} in room ${roomId}`);

    const targetClient = Array.from(connectedClients.values())
      .find(client => client.clientId === targetId && client.roomId === roomId);

    if (targetClient) {
      targetClient.socket.emit('webrtc-answer', {
        fromId: connectedClients.get(socket.id)?.clientId,
        answer,
        roomId
      });
    }
  });

  socket.on('webrtc-ice-candidate', (data) => {
    const { targetId, candidate, roomId } = data;
    console.log(`ICE candidate from ${socket.id} to ${targetId} in room ${roomId}`);

    const targetClient = Array.from(connectedClients.values())
      .find(client => client.clientId === targetId && client.roomId === roomId);

    if (targetClient) {
      targetClient.socket.emit('webrtc-ice-candidate', {
        fromId: connectedClients.get(socket.id)?.clientId,
        candidate,
        roomId
      });
    }
  });

  // Handle mobile-ready message
  socket.on('mobile-ready', (data) => {
    const client = connectedClients.get(socket.id);
    if (client) {
      console.log(`Mobile client ready: ${client.clientId} in room ${client.roomId}`);
      // Broadcast to laptop clients in the same room
      socket.to(client.roomId).emit('mobile-ready', {
        fromId: client.clientId,
        roomId: client.roomId,
        timestamp: data.timestamp
      });
    }
  });

  // Handle room messages (broadcast to room)
  socket.on('room-message', (data) => {
    const { roomId, message } = data;
    console.log(`Room message in ${roomId}:`, message);

    socket.to(roomId).emit('room-message', {
      fromId: connectedClients.get(socket.id)?.clientId,
      message,
      roomId
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    const client = connectedClients.get(socket.id);
    if (client) {
      const { roomId } = client;

      // Remove from room
      if (rooms.has(roomId)) {
        rooms.get(roomId).delete(socket.id);
        if (rooms.get(roomId).size === 0) {
          rooms.delete(roomId);
        }
      }

      // Notify others in the room
      socket.to(roomId).emit('client-left', {
        clientId: client.clientId,
        socketId: socket.id
      });

      connectedClients.delete(socket.id);
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedClients: connectedClients.size,
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Return the server's LAN IP so the frontend can show the correct mobile URL
app.get('/api/local-ip', (req, res) => {
  const interfaces = os.networkInterfaces();
  let lanIp = 'localhost';
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        lanIp = addr.address;
        break;
      }
    }
    if (lanIp !== 'localhost') break;
  }
  res.json({ ip: lanIp, port: process.env.PORT || 3001 });
});

// ── Spotify OAuth Routes ──────────────────────────────────────────────────────

/** Step 1: Redirect to Spotify authorization */
app.get('/login', (req, res) => {
  if (!SPOTIFY_CLIENT_ID) {
    return res.status(500).send('SPOTIFY_CLIENT_ID not set in .env');
  }
  const scopes = [
    'streaming',
    'user-read-email',
    'user-read-private',
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-library-read'
  ].join(' ');

  const authUrl = 'https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: SPOTIFY_CLIENT_ID,
      scope: scopes,
      redirect_uri: SPOTIFY_REDIRECT_URI
    });
  res.redirect(authUrl);
});

/** Step 2: Spotify redirects back with ?code= */
app.get('/callback', (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('Missing code from Spotify');

  const body = querystring.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI
  });
  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

  const options = {
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const tokenReq = https.request(options, (tokenRes) => {
    let data = '';
    tokenRes.on('data', c => { data += c; });
    tokenRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.access_token) {
          spotifyTokens.access_token = json.access_token;
          spotifyTokens.refresh_token = json.refresh_token;
          spotifyTokens.expires_at = Date.now() + (json.expires_in * 1000);
          console.log('[Spotify] Logged in successfully');
          res.redirect('/?spotify=connected');
        } else {
          console.error('[Spotify] Token exchange failed:', json);
          res.status(500).send('Spotify auth failed: ' + JSON.stringify(json));
        }
      } catch (e) {
        res.status(500).send('Failed to parse Spotify response');
      }
    });
  });
  tokenReq.on('error', e => res.status(500).send(e.message));
  tokenReq.write(body);
  tokenReq.end();
});

/** Return current access token to the frontend */
app.get('/api/token', (req, res) => {
  if (!spotifyTokens.access_token) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  const expiresIn = Math.floor((spotifyTokens.expires_at - Date.now()) / 1000);
  res.json({ access_token: spotifyTokens.access_token, expires_in: expiresIn });
});

/** Refresh token endpoint */
app.get('/api/refresh', (req, res) => {
  if (!spotifyTokens.refresh_token) {
    return res.status(401).json({ error: 'No refresh token' });
  }
  const body = querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: spotifyTokens.refresh_token
  });
  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const options = {
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  };
  const req2 = https.request(options, (r) => {
    let data = '';
    r.on('data', c => { data += c; });
    r.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.access_token) {
          spotifyTokens.access_token = json.access_token;
          spotifyTokens.expires_at = Date.now() + (json.expires_in * 1000);
          if (json.refresh_token) spotifyTokens.refresh_token = json.refresh_token;
          res.json({ access_token: json.access_token, expires_in: json.expires_in });
        } else {
          res.status(500).json({ error: 'Refresh failed', details: json });
        }
      } catch { res.status(500).json({ error: 'Parse error' }); }
    });
  });
  req2.on('error', e => res.status(500).json({ error: e.message }));
  req2.write(body);
  req2.end();
});

/** Proxy Spotify Search */
app.get('/api/search', async (req, res) => {
  if (!spotifyTokens.access_token) return res.status(401).json({ error: 'Not logged in' });
  const { q, type = 'track', limit = 20 } = req.query;
  const endpoint = `/search?q=${encodeURIComponent(q)}&type=${type}&limit=${limit}`;
  try {
    const result = await spotifyRequest('GET', endpoint, spotifyTokens.access_token);
    res.status(result.status).json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Proxy Spotify Playback – play a track */
app.put('/api/play', async (req, res) => {
  if (!spotifyTokens.access_token) return res.status(401).json({ error: 'Not logged in' });
  const { uris, device_id } = req.body;
  const endpoint = `/me/player/play${device_id ? '?device_id=' + device_id : ''}`;
  try {
    const result = await spotifyRequest('PUT', endpoint, spotifyTokens.access_token, { uris });
    res.status(result.status).json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Proxy Spotify Playback – pause */
app.put('/api/pause', async (req, res) => {
  if (!spotifyTokens.access_token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await spotifyRequest('PUT', '/me/player/pause', spotifyTokens.access_token);
    res.status(result.status).json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Proxy Spotify Playback – skip to next */
app.post('/api/next', async (req, res) => {
  if (!spotifyTokens.access_token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await spotifyRequest('POST', '/me/player/next', spotifyTokens.access_token);
    res.status(result.status).json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Proxy Spotify Playback – skip to previous */
app.post('/api/previous', async (req, res) => {
  if (!spotifyTokens.access_token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await spotifyRequest('POST', '/me/player/previous', spotifyTokens.access_token);
    res.status(result.status).json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Proxy – get user playlists */
app.get('/api/playlists', async (req, res) => {
  if (!spotifyTokens.access_token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await spotifyRequest('GET', '/me/playlists?limit=20', spotifyTokens.access_token);
    res.status(result.status).json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Proxy – logout */
app.post('/api/logout', (req, res) => {
  spotifyTokens = { access_token: null, refresh_token: null, expires_at: 0 };
  res.json({ ok: true });
});

/** Proxy – what's currently playing on any Spotify device */
app.get('/api/currently-playing', async (req, res) => {
  if (!spotifyTokens.access_token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const result = await spotifyRequest('GET', '/me/player/currently-playing', spotifyTokens.access_token);
    if (result.status === 204) return res.status(204).end(); // nothing playing
    res.status(result.status).json(result.body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get room info
app.get('/room/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  const roomClients = rooms.get(roomId);

  if (!roomClients) {
    return res.json({ roomId, clients: [] });
  }

  const clients = Array.from(roomClients).map(socketId => {
    const client = connectedClients.get(socketId);
    return client ? {
      socketId,
      clientType: client.clientType,
      clientId: client.clientId
    } : null;
  }).filter(Boolean);

  res.json({ roomId, clients });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});