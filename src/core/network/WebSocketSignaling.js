import { EventEmitter } from '../utils/EventEmitter.js';
import { logger } from '../utils/Logger.js';

class WebSocketSignaling extends EventEmitter {
    constructor(serverUrl) {
        super();
        this.serverUrl = serverUrl;
        this.ws = null;
        this.log = logger.createScopedLogger('WebSocketSignaling');
        this.peerId = null;
    }

    connect(peerId) {
        this.peerId = peerId;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.log.warn('WebSocket is already connected.');
            return;
        }

        this.ws = new WebSocket(this.serverUrl);

        this.ws.onopen = () => {
            this.log.info('WebSocket connection established.');
            this.emit('open');
            // Announce presence
            this.sendMessage({ type: 'connect', peerId: this.peerId });
        };

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.log.debug('Received message', { message });
                this.emit('message', message);
            } catch (error) {
                this.log.error('Failed to parse incoming message', { data: event.data, error });
            }
        };

        this.ws.onerror = (error) => {
            this.log.error('WebSocket error', { error });
            this.emit('error', error);
        };

        this.ws.onclose = () => {
            this.log.info('WebSocket connection closed.');
            this.emit('close');
        };
    }

    sendMessage(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // Make sure to include peerId for routing on the other side
            const outgoingMessage = { ...message, senderId: this.peerId };
            this.ws.send(JSON.stringify(outgoingMessage));
            this.log.debug('Sent message', { message: outgoingMessage });
        } else {
            this.log.error('WebSocket is not connected. Cannot send message.');
        }
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

export { WebSocketSignaling };