import { EventEmitter } from '../utils/EventEmitter.js';
import { logger } from '../utils/Logger.js';

class WebSocketSignaling extends EventEmitter {
    constructor(serverUrl) {
        super();
        this.serverUrl = serverUrl;
        this.socket = null;
        this.log = logger.createScopedLogger('WebSocketSignaling');
        this.peerId = null;
        this.isConnected = false;
    }

    connect(peerId) {
        this.peerId = peerId;
        if (this.socket && this.isConnected) {
            this.log.warn('Socket.IO is already connected.');
            return;
        }

        // Import socket.io client dynamically
        import('socket.io-client').then(({ io }) => {
            this.socket = io(this.serverUrl, {
                transports: ['websocket', 'polling']
            });

            this.socket.on('connect', () => {
                this.log.info('Socket.IO connection established.');
                console.log('[DEBUG] WebSocket signaling connected to:', this.serverUrl);
                this.isConnected = true;
                this.emit('open');
            });

            this.socket.on('disconnect', () => {
                this.log.info('Socket.IO connection closed.');
                console.log('[DEBUG] WebSocket signaling disconnected from:', this.serverUrl);
                this.isConnected = false;
                this.emit('close');
            });

            this.socket.on('connect_error', (error) => {
                this.log.error('Socket.IO connection error', { error });
                console.error('[DEBUG] WebSocket signaling connection failed:', this.serverUrl, error.message);
                this.emit('error', error);
            });

            // Handle custom signaling messages
            this.socket.on('webrtc-offer', (data) => {
                this.emit('message', { type: 'webrtc-offer', ...data });
            });

            this.socket.on('webrtc-answer', (data) => {
                this.emit('message', { type: 'webrtc-answer', ...data });
            });

            this.socket.on('webrtc-ice-candidate', (data) => {
                this.emit('message', { type: 'webrtc-ice-candidate', ...data });
            });

            this.socket.on('mobile-ready', (data) => {
                this.emit('message', { type: 'mobile-ready', ...data });
            });

            this.socket.on('client-joined', (data) => {
                this.emit('message', { type: 'client-joined', ...data });
            });

            this.socket.on('client-left', (data) => {
                this.emit('message', { type: 'client-left', ...data });
            });

            this.socket.on('room-message', (data) => {
                this.emit('message', { type: 'room-message', ...data });
            });

        }).catch(error => {
            this.log.error('Failed to load socket.io-client', { error });
            this.emit('error', error);
        });
    }

    sendMessage(message) {
        if (this.socket && this.isConnected) {
            // Send message via Socket.IO
            const outgoingMessage = { ...message, senderId: this.peerId };
            this.socket.emit(message.type, outgoingMessage);
            this.log.debug('Sent message', { message: outgoingMessage });
        } else {
            this.log.error('Socket.IO is not connected. Cannot send message.');
        }
    }

    close() {
        if (this.socket) {
            this.socket.disconnect();
            this.isConnected = false;
        }
    }
}

export { WebSocketSignaling };