const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

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