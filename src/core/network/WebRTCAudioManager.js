import { EventEmitter } from '../utils/EventEmitter.js';
import { logger } from '../utils/Logger.js';

/**
 * WebRTCAudioManager handles peer-to-peer audio streaming to mobile devices
 * This allows mobile devices to act as additional speakers synchronized with laptop audio
 */
class WebRTCAudioManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Configuration
        this.iceServers = options.iceServers || [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ];
        this.audioConstraints = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: options.sampleRate || 44100
        };
        
        // Connection management
        this.connections = new Map(); // peerId -> RTCPeerConnection
        this.dataChannels = new Map(); // peerId -> RTCDataChannel
        this.remoteAudioStreams = new Map(); // peerId -> MediaStream
        
        // Audio streaming state
        this.isStreaming = false;
        this.audioContext = null;
        this.sourceNode = null;
        this.destinationNode = null;
        
        // Mobile peer tracking
        this.connectedPeers = new Set();
        this.pendingConnections = new Set();
        
        // Statistics
        this.connectionStats = {
            totalConnections: 0,
            successfulConnections: 0,
            failedConnections: 0,
            averageConnectionTime: 0,
            totalDataTransferred: 0
        };
        
        this.log = logger.createScopedLogger('WebRTCAudioManager');

        // Initialize audio context asynchronously
        this._initializeAudioContext().catch(error => {
            this.log.error('Failed to initialize WebRTC AudioContext in constructor', { error: error.message });
        });
    }

    /**
     * Initialize Web Audio context for streaming
     * @private
     */
    async _initializeAudioContext() {
        try {
            this.log.debug('Attempting to initialize WebRTC AudioContext', {
                hasAudioContext: !!window.AudioContext,
                hasWebkitAudioContext: !!window.webkitAudioContext,
                userAgent: navigator.userAgent
            });

            const AudioContextClass = window.AudioContext || window.webkitAudioContext;

            if (!AudioContextClass) {
                throw new Error('AudioContext not available in this browser');
            }

            try {
                this.audioContext = new AudioContextClass({
                    sampleRate: 44100
                });
            } catch (error) {
                if (error.message.includes('cannot be called as a function')) {
                    this.audioContext = AudioContextClass({
                        sampleRate: 44100
                    });
                } else {
                    this.log.error('Failed to instantiate AudioContext', { error: error.message });
                    this.audioContext = null;
                }
            }

            // Resume AudioContext if it's suspended (required in modern browsers)
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

            this.log.info('WebRTC Audio context initialized successfully', {
                state: this.audioContext.state,
                sampleRate: this.audioContext.sampleRate
            });

        } catch (error) {
            this.log.error('Failed to initialize audio context', {
                error: error.message,
                errorName: error.name,
                stack: error.stack,
                hasAudioContext: !!window.AudioContext,
                hasWebkitAudioContext: !!window.webkitAudioContext
            });
            throw error;
        }
    }

    /**
     * Check if WebRTC is supported
     * @returns {boolean} True if supported
     */
    isSupported() {
        return !!(window.RTCPeerConnection && 
                 window.RTCSessionDescription && 
                 window.RTCIceCandidate &&
                 this.audioContext);
    }

    /**
     * Create a connection offer for a new mobile peer
     * @param {string} peerId - Unique peer identifier
     * @returns {Promise<object>} Connection offer data
     */
    async createConnectionOffer(peerId) {
        if (!this.isSupported()) {
            throw new Error('WebRTC not supported in this browser');
        }

        try {
            this.log.info('Creating connection offer', { peerId, supported: this.isSupported() });

            // Create peer connection
            const peerConnection = new RTCPeerConnection({
                iceServers: this.iceServers,
                iceCandidatePoolSize: 10,
                bundlePolicy: 'max-bundle',
                rtcpMuxPolicy: 'require'
            });
            
            this.connections.set(peerId, peerConnection);
            this.pendingConnections.add(peerId);

            // Set up connection event handlers
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    this.emit('iceCandidate', { peerId, candidate: event.candidate });
                }
            };

            peerConnection.onconnectionstatechange = () => {
                this._handleConnectionStateChange(peerId, peerConnection.connectionState);
            };

            peerConnection.ontrack = (event) => {
                this._handleRemoteStream(peerId, event.streams[0]);
            };

            // Create data channel for control messages
            const dataChannel = peerConnection.createDataChannel('audioControl', {
                ordered: true
            });
            
            dataChannel.onopen = () => {
                this.log.info('Data channel opened', { peerId });
                this.dataChannels.set(peerId, dataChannel);
            };

            dataChannel.onmessage = (event) => {
                this._handleDataChannelMessage(peerId, event.data);
            };

            dataChannel.onerror = (error) => {
                this.log.error('Data channel error', { peerId, error: error.message });
            };

            // Set up ICE gathering timeout
            let iceGatheringResolve;
            const iceGatheringPromise = new Promise(resolve => {
                iceGatheringResolve = resolve;
            });
            peerConnection.onicegatheringstatechange = () => {
                if (peerConnection.iceGatheringState === 'complete') {
                    iceGatheringResolve();
                }
            };

            // Create offer
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: false,
                voiceActivityDetection: false
            });

            await peerConnection.setLocalDescription(offer);

            // Wait for ICE gathering to complete or timeout
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('ICE gathering timeout after 10 seconds')), 10000);
            });
            await Promise.race([iceGatheringPromise, timeoutPromise]);

            // Update statistics
            this.connectionStats.totalConnections++;

            this.log.info('Connection offer created', { 
                peerId, 
                offerType: offer.type 
            });

            return {
                peerId,
                offer: {
                    type: offer.type,
                    sdp: offer.sdp
                },
                timestamp: Date.now()
            };

        } catch (error) {
            this.log.error('Failed to create connection offer', { 
                peerId, 
                error: error.message 
            });
            this._cleanupFailedConnection(peerId);
            throw error;
        }
    }

    /**
     * Accept a connection answer from a mobile peer
     * @param {string} peerId - Peer identifier
     * @param {object} answer - Connection answer data
     * @returns {Promise<void>}
     */
    async acceptConnectionAnswer(peerId, answer) {
        try {
            const peerConnection = this.connections.get(peerId);

            if (!peerConnection) {
                throw new Error(`No pending connection found for peer ${peerId}`);
            }

            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));

            this.pendingConnections.delete(peerId);
            this.connectedPeers.add(peerId);

            // Update statistics
            const connectionTime = Date.now() - (this.connectionStats.lastConnectionStart || Date.now());
            this.connectionStats.successfulConnections++;
            this.connectionStats.averageConnectionTime =
                (this.connectionStats.averageConnectionTime + connectionTime) / 2;

            this.log.info('Connection established', { peerId });
            this.emit('connectionEstablished', { peerId });

        } catch (error) {
            this.log.error('Failed to accept connection answer', {
                peerId,
                error: error.message
            });
            this._cleanupFailedConnection(peerId);
            throw error;
        }
    }

    /**
     * Add ICE candidate from remote peer
     * @param {string} peerId - Peer identifier
     * @param {object} candidate - ICE candidate data
     * @returns {Promise<void>}
     */
    async addIceCandidate(peerId, candidate) {
        try {
            const peerConnection = this.connections.get(peerId);

            if (!peerConnection) {
                throw new Error(`No connection found for peer ${peerId}`);
            }

            if (candidate) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                this.log.debug('ICE candidate added', { peerId });
            }

        } catch (error) {
            this.log.error('Failed to add ICE candidate', {
                peerId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Handle connection state changes
     * @param {string} peerId - Peer identifier
     * @param {string} state - Connection state
     * @private
     */
    _handleConnectionStateChange(peerId, state) {
        this.log.debug('Connection state changed', { peerId, state });

        switch (state) {
            case 'connected':
                this.connectedPeers.add(peerId);
                this.pendingConnections.delete(peerId);
                this.emit('peerConnected', { peerId });
                break;
                
            case 'disconnected':
            case 'failed':
                this._handlePeerDisconnection(peerId);
                break;
                
            case 'closed':
                this._cleanupPeerConnection(peerId);
                break;
        }
    }

    /**
     * Handle remote audio stream from peer
     * @param {string} peerId - Peer identifier
     * @param {MediaStream} stream - Remote audio stream
     * @private
     */
    _handleRemoteStream(peerId, stream) {
        this.remoteAudioStreams.set(peerId, stream);
        
        // Create audio element for remote stream
        const audioElement = new Audio();
        audioElement.srcObject = stream;
        audioElement.autoplay = true;
        audioElement.volume = 1.0;
        
        this.emit('remoteStreamReceived', { peerId, stream, audioElement });
        
        this.log.info('Remote audio stream received', { peerId });
    }

    /**
     * Handle data channel messages
     * @param {string} peerId - Peer identifier
     * @param {string} data - Message data
     * @private
     */
    _handleDataChannelMessage(peerId, data) {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'ping':
                    this._sendDataChannelMessage(peerId, { type: 'pong', timestamp: Date.now() });
                    break;
                    
                case 'volumeControl':
                    this.emit('volumeControl', { peerId, volume: message.volume });
                    break;
                    
                case 'audioLevel':
                    this.emit('audioLevel', { peerId, level: message.level });
                    break;
                    
                default:
                    this.log.debug('Unknown data channel message', { peerId, message });
            }
            
        } catch (error) {
            this.log.error('Failed to parse data channel message', { 
                peerId, 
                data, 
                error: error.message 
            });
        }
    }

    /**
     * Send audio stream to all connected peers
     * @param {MediaStream} audioStream - Audio stream to broadcast
     * @returns {Promise<void>}
     */
    async startAudioStreaming(audioStream) {
        if (!this.isSupported()) {
            throw new Error('WebRTC not supported');
        }

        try {
            this.log.info('Starting audio streaming to peers');

            // Add track to all peer connections
            const audioTrack = audioStream.getAudioTracks()[0];
            
            for (const [peerId, peerConnection] of this.connections) {
                if (peerConnection.connectionState === 'connected') {
                    peerConnection.addTrack(audioTrack, audioStream);
                    this.log.debug('Audio track added to peer', { peerId });
                }
            }

            this.isStreaming = true;
            this.emit('audioStreamingStarted');

        } catch (error) {
            this.log.error('Failed to start audio streaming', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop audio streaming to all peers
     */
    stopAudioStreaming() {
        if (this.isStreaming) {
            this.log.info('Stopping audio streaming');

            // Remove tracks from all peer connections
            for (const [peerId, peerConnection] of this.connections) {
                if (peerConnection.connectionState === 'connected') {
                    const senders = peerConnection.getSenders();
                    senders.forEach(sender => {
                        if (sender.track && sender.track.kind === 'audio') {
                            peerConnection.removeTrack(sender);
                        }
                    });
                }
            }

            this.isStreaming = false;
            this.emit('audioStreamingStopped');
        }
    }

    /**
     * Send control message to specific peer
     * @param {string} peerId - Peer identifier
     * @param {object} message - Message to send
     * @private
     */
    _sendDataChannelMessage(peerId, message) {
        const dataChannel = this.dataChannels.get(peerId);
        
        if (dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(JSON.stringify(message));
        }
    }

    /**
     * Broadcast message to all connected peers
     * @param {object} message - Message to broadcast
     */
    broadcastMessage(message) {
        for (const peerId of this.connectedPeers) {
            this._sendDataChannelMessage(peerId, message);
        }
    }

    /**
     * Handle peer disconnection
     * @param {string} peerId - Peer identifier
     * @private
     */
    _handlePeerDisconnection(peerId) {
        this.log.info('Peer disconnected', { peerId });
        
        this.connectedPeers.delete(peerId);
        this.pendingConnections.delete(peerId);
        
        this.emit('peerDisconnected', { peerId });
    }

    /**
     * Clean up failed connection
     * @param {string} peerId - Peer identifier
     * @private
     */
    _cleanupFailedConnection(peerId) {
        this.pendingConnections.delete(peerId);
        this.connections.delete(peerId);
        this.dataChannels.delete(peerId);
        this.remoteAudioStreams.delete(peerId);
        
        this.connectionStats.failedConnections++;
    }

    /**
     * Clean up peer connection
     * @param {string} peerId - Peer identifier
     * @private
     */
    _cleanupPeerConnection(peerId) {
        const peerConnection = this.connections.get(peerId);
        
        if (peerConnection) {
            peerConnection.close();
        }
        
        this.connections.delete(peerId);
        this.dataChannels.delete(peerId);
        this.remoteAudioStreams.delete(peerId);
        this.connectedPeers.delete(peerId);
        this.pendingConnections.delete(peerId);
    }

    /**
     * Disconnect specific peer
     * @param {string} peerId - Peer identifier
     */
    disconnectPeer(peerId) {
        this.log.info('Disconnecting peer', { peerId });
        
        const peerConnection = this.connections.get(peerId);
        
        if (peerConnection) {
            peerConnection.close();
        }
        
        this._cleanupPeerConnection(peerId);
        
        this.emit('peerDisconnected', { peerId });
    }

    /**
     * Disconnect all peers
     */
    disconnectAllPeers() {
        this.log.info('Disconnecting all peers');
        
        for (const peerId of this.connectedPeers) {
            this.disconnectPeer(peerId);
        }
    }

    /**
     * Get connection statistics
     * @returns {object} Statistics
     */
    getStats() {
        return {
            ...this.connectionStats,
            supported: this.isSupported(),
            isStreaming: this.isStreaming,
            connectedPeers: this.connectedPeers.size,
            totalPeers: this.connections.size,
            pendingConnections: this.pendingConnections.size,
            peerIds: Array.from(this.connectedPeers)
        };
    }

    /**
     * Get list of connected peers
     * @returns {Array} Connected peer IDs
     */
    getConnectedPeers() {
        return Array.from(this.connectedPeers);
    }

    /**
     * Check if peer is connected
     * @param {string} peerId - Peer identifier
     * @returns {boolean} True if connected
     */
    isPeerConnected(peerId) {
        return this.connectedPeers.has(peerId);
    }

    /**
     * Clean up resources
     */
    cleanup() {
        this.stopAudioStreaming();
        this.disconnectAllPeers();
        
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }
        
        this.emit('cleanup');
        this.log.info('WebRTC Audio Manager cleaned up');
    }
}

export { WebRTCAudioManager };