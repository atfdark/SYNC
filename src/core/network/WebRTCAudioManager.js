import { EventEmitter } from '../utils/EventEmitter.js';
import { logger } from '../utils/Logger.js';
import { WebSocketSignaling } from './WebSocketSignaling.js';

/**
 * WebRTCAudioManager handles peer-to-peer audio streaming to mobile devices
 * This allows mobile devices to act as additional speakers synchronized with laptop audio
 */
class WebRTCAudioManager extends EventEmitter {
    constructor(options = {}) {
        super();

        // Configuration
        this.iceServers = options.iceServers || [
            // Multiple STUN servers for better connectivity
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            // TURN servers for NAT traversal
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            // Alternative TURN server
            {
                urls: 'turn:turn.bistri.com:80',
                username: 'homeo',
                credential: 'homeo'
            }
        ];
        this.audioConstraints = {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: options.sampleRate || 44100
        };

        // Signaling configuration
        this.signalingServerUrl = options.signalingServerUrl || `${window.location.protocol}//${window.location.host}`;
        this.roomId = options.roomId || 'syncplay-room';
        this.clientId = options.clientId || this._generateClientId();
        this.signaling = null;
        
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

        // Initialize signaling
        this._initializeSignaling();

        // Initialize audio context asynchronously
        this._initializeAudioContext().catch(error => {
            this.log.error('Failed to initialize WebRTC AudioContext in constructor', { error: error.message });
        });
    }

    /**
     * Initialize WebSocket signaling
     * @private
     */
    _initializeSignaling() {
        this.signaling = new WebSocketSignaling(this.signalingServerUrl);

        this.signaling.on('open', () => {
            this.log.info('Signaling connection established');
            // Register with the signaling server
            this.signaling.sendMessage({
                type: 'register',
                clientType: 'laptop', // or 'mobile' depending on context
                clientId: this.clientId,
                roomId: this.roomId
            });
        });

        this.signaling.on('message', (message) => {
            this._handleSignalingMessage(message);
        });

        this.signaling.on('error', (error) => {
            this.log.error('Signaling error', { error });
        });

        this.signaling.on('close', () => {
            this.log.warn('Signaling connection closed');
        });

        // Connect to signaling server
        this.signaling.connect(this.clientId);
    }

    /**
     * Handle incoming signaling messages
     * @param {object} message - Signaling message
     * @private
     */
    _handleSignalingMessage(message) {
        switch (message.type) {
            case 'webrtc-offer':
                this._handleIncomingOffer(message);
                break;
            case 'webrtc-answer':
                this._handleIncomingAnswer(message);
                break;
            case 'webrtc-ice-candidate':
                this._handleIncomingIceCandidate(message);
                break;
            case 'mobile-ready':
                this._handleMobileReady(message);
                break;
            case 'client-joined':
                this.emit('clientJoined', message);
                break;
            case 'client-left':
                this.emit('clientLeft', message);
                break;
            default:
                this.log.debug('Unknown signaling message', { message });
        }
    }

    /**
     * Generate a unique client ID
     * @returns {string} Client ID
     * @private
     */
    _generateClientId() {
        return 'client_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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

            // Try to create AudioContext with different options for better compatibility
            try {
                // First try without options
                this.audioContext = new AudioContextClass();
            } catch (firstError) {
                this.log.warn('Failed to create AudioContext without options, trying with sampleRate', { error: firstError.message });
                try {
                    // Try with sampleRate option
                    this.audioContext = new AudioContextClass({
                        sampleRate: 44100
                    });
                } catch (secondError) {
                    this.log.warn('Failed to create AudioContext with sampleRate, trying legacy constructor', { error: secondError.message });
                    try {
                        // Try legacy constructor syntax
                        this.audioContext = AudioContextClass({
                            sampleRate: 44100
                        });
                    } catch (thirdError) {
                        this.log.error('All AudioContext constructor attempts failed', {
                            firstError: firstError.message,
                            secondError: secondError.message,
                            thirdError: thirdError.message
                        });
                        this.audioContext = null;
                    }
                }
            }

            if (this.audioContext) {
                // Resume AudioContext if it's suspended (required in modern browsers)
                if (this.audioContext.state === 'suspended') {
                    try {
                        await this.audioContext.resume();
                    } catch (resumeError) {
                        this.log.warn('Failed to resume AudioContext', { error: resumeError.message });
                        // Continue anyway, as some contexts may work suspended
                    }
                }

                this.log.info('WebRTC Audio context initialized successfully', {
                    state: this.audioContext.state,
                    sampleRate: this.audioContext.sampleRate
                });
            } else {
                throw new Error('AudioContext creation failed with all methods');
            }

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
            console.log('[DEBUG] Creating WebRTC connection offer for peer:', peerId);
            this.log.info('Creating connection offer', { peerId, supported: this.isSupported() });

            // Create peer connection
            console.log('[DEBUG] Creating RTCPeerConnection');
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
                    console.log('[DEBUG] Generated ICE candidate for offer:', { peerId, type: event.candidate.type });
                    // Send ICE candidate via signaling
                    this.signaling.sendMessage({
                        type: 'webrtc-ice-candidate',
                        targetId: peerId,
                        candidate: event.candidate,
                        roomId: this.roomId
                    });
                }
            };

            peerConnection.onconnectionstatechange = () => {
                this._handleConnectionStateChange(peerId, peerConnection.connectionState);
            };

            peerConnection.ontrack = (event) => {
                console.log('[DEBUG] Received remote track in offerer');
                this._handleRemoteStream(peerId, event.streams[0]);
            };

            // Create data channel for control messages
            console.log('[DEBUG] Creating data channel');
            const dataChannel = peerConnection.createDataChannel('audioControl', {
                ordered: true
            });

            dataChannel.onopen = () => {
                console.log('[DEBUG] Data channel opened for peer:', peerId);
                this.log.info('Data channel opened', { peerId });
                this.dataChannels.set(peerId, dataChannel);
            };

            dataChannel.onmessage = (event) => {
                this._handleDataChannelMessage(peerId, event.data);
            };

            dataChannel.onerror = (error) => {
                console.error('[DEBUG] Data channel error for peer:', peerId, error.message);
                this.log.error('Data channel error', { peerId, error: error.message });
            };

            // Set up ICE gathering with retry logic
            let iceGatheringResolve;
            let iceRetryCount = 0;
            const maxIceRetries = 3;

            const attemptIceGathering = () => new Promise(async (resolve, reject) => {
                iceGatheringResolve = resolve;
                const timeout = setTimeout(() => {
                    if (iceRetryCount < maxIceRetries) {
                        iceRetryCount++;
                        this.log.warn(`ICE gathering timeout, retrying (${iceRetryCount}/${maxIceRetries})`);
                        clearTimeout(timeout);
                        attemptIceGathering().then(resolve).catch(reject);
                    } else {
                        reject(new Error(`ICE gathering failed after ${maxIceRetries} retries`));
                    }
                }, 10000 + (iceRetryCount * 5000)); // Increasing timeout

                peerConnection.onicegatheringstatechange = () => {
                    console.log('[DEBUG] ICE gathering state changed to:', peerConnection.iceGatheringState);
                    if (peerConnection.iceGatheringState === 'complete') {
                        clearTimeout(timeout);
                        resolve();
                    }
                };
            });

            // Create offer
            console.log('[DEBUG] Creating WebRTC offer');
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: false,
                voiceActivityDetection: false
            });

            console.log('[DEBUG] Setting local description');
            await peerConnection.setLocalDescription(offer);

            // Wait for ICE gathering to complete with retries
            console.log('[DEBUG] Waiting for ICE gathering to complete');
            await attemptIceGathering();
            console.log('[DEBUG] ICE gathering completed successfully');

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
            console.error('[DEBUG] Failed to create connection offer:', { peerId, error: error.message, stack: error.stack });
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
            // Validate answer format
            if (!answer || typeof answer !== 'object') {
                throw new Error('Invalid answer format: answer must be an object');
            }
            if (!answer.type || !answer.sdp) {
                throw new Error('Invalid answer format: missing type or sdp');
            }
            if (answer.type !== 'answer') {
                throw new Error(`Invalid answer type: expected 'answer', got '${answer.type}'`);
            }

            const peerConnection = this.connections.get(peerId);

            if (!peerConnection) {
                throw new Error(`No pending connection found for peer ${peerId}`);
            }

            console.log('[DEBUG] Setting remote description for answer');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            console.log('[DEBUG] Remote description set successfully');

            this.pendingConnections.delete(peerId);

            // Update statistics
            const connectionTime = Date.now() - (this.connectionStats.lastConnectionStart || Date.now());
            this.connectionStats.successfulConnections++;
            this.connectionStats.averageConnectionTime =
                (this.connectionStats.averageConnectionTime + connectionTime) / 2;

            this.log.info('Connection established', { peerId });
            this.emit('connectionEstablished', { peerId });

        } catch (error) {
            console.error('[DEBUG] Failed to accept connection answer:', { peerId, error: error.message, stack: error.stack });
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
        console.log('[DEBUG] WebRTC connection state changed:', { peerId, state });
        this.log.debug('Connection state changed', { peerId, state });

        const peerConnection = this.connections.get(peerId);
        const iceConnectionState = peerConnection?.iceConnectionState;
        const iceGatheringState = peerConnection?.iceGatheringState;

        switch (state) {
            case 'connected':
                console.log('[DEBUG] WebRTC peer connected successfully:', peerId);
                this.connectedPeers.add(peerId);
                this.pendingConnections.delete(peerId);
                this.emit('peerConnected', { peerId });
                break;

            case 'disconnected':
                console.log('[DEBUG] WebRTC peer disconnected:', peerId);
                this._handlePeerDisconnection(peerId);
                this.emit('connectionError', {
                    peerId,
                    error: 'Peer disconnected',
                    state,
                    iceConnectionState,
                    iceGatheringState
                });
                break;

            case 'failed':
                console.error('[DEBUG] WebRTC connection failed:', peerId);
                this._handlePeerDisconnection(peerId);
                this.emit('connectionError', {
                    peerId,
                    error: 'Connection failed',
                    state,
                    iceConnectionState,
                    iceGatheringState,
                    reason: 'ICE connection failed or timed out'
                });
                break;

            case 'closed':
                console.log('[DEBUG] WebRTC connection closed:', peerId);
                this._cleanupPeerConnection(peerId);
                break;

            default:
                console.log('[DEBUG] WebRTC connection state:', { peerId, state });
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
     * Handle mobile-ready message to initiate offer creation
     * @param {object} message - Signaling message
     * @private
     */
    async _handleMobileReady(message) {
        const mobileClientId = message.fromId || message.senderId;
        this.log.info('Mobile client ready, creating connection offer', { mobileClientId });

        try {
            const offerData = await this.createConnectionOffer(mobileClientId);
            // Send offer via signaling
            this.signaling.sendMessage({
                type: 'webrtc-offer',
                targetId: mobileClientId,
                offer: offerData.offer,
                roomId: this.roomId
            });
            this.log.info('Offer sent to mobile client', { mobileClientId });
        } catch (error) {
            this.log.error('Failed to create offer for mobile client', { mobileClientId, error: error.message });
        }
    }

    /**
     * Handle incoming WebRTC offer
     * @param {object} message - Signaling message
     * @private
     */
    async _handleIncomingOffer(message) {
        const { fromId, offer } = message;
        this.log.info('Received WebRTC offer', { fromId });

        try {
            // Create answer automatically
            const answerData = await this.createConnectionAnswer(fromId, offer);
            // Send answer via signaling
            this.signaling.sendMessage({
                type: 'webrtc-answer',
                targetId: fromId,
                answer: answerData.answer,
                roomId: this.roomId
            });
        } catch (error) {
            this.log.error('Failed to handle incoming offer', { fromId, error: error.message });
        }
    }

    /**
     * Handle incoming WebRTC answer
     * @param {object} message - Signaling message
     * @private
     */
    async _handleIncomingAnswer(message) {
        const { fromId, answer } = message;
        this.log.info('Received WebRTC answer', { fromId });

        try {
            await this.acceptConnectionAnswer(fromId, answer);
        } catch (error) {
            this.log.error('Failed to handle incoming answer', { fromId, error: error.message });
        }
    }

    /**
     * Handle incoming ICE candidate
     * @param {object} message - Signaling message
     * @private
     */
    async _handleIncomingIceCandidate(message) {
        const { fromId, candidate } = message;
        this.log.debug('Received ICE candidate', { fromId });

        try {
            await this.addIceCandidate(fromId, candidate);
        } catch (error) {
            this.log.error('Failed to handle incoming ICE candidate', { fromId, error: error.message });
        }
    }

    /**
     * Create a connection answer for an incoming offer
     * @param {string} peerId - Peer identifier
     * @param {object} offer - Connection offer data
     * @returns {Promise<object>} Connection answer data
     */
    async createConnectionAnswer(peerId, offer) {
        if (!this.isSupported()) {
            throw new Error('WebRTC not supported in this browser');
        }

        try {
            this.log.info('Creating connection answer', { peerId });

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
                    // Send ICE candidate via signaling
                    this.signaling.sendMessage({
                        type: 'webrtc-ice-candidate',
                        targetId: peerId,
                        candidate: event.candidate,
                        roomId: this.roomId
                    });
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

            // Set remote description
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

            // Create answer
            const answer = await peerConnection.createAnswer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: false,
                voiceActivityDetection: false
            });

            await peerConnection.setLocalDescription(answer);

            // Update statistics
            this.connectionStats.totalConnections++;

            this.log.info('Connection answer created', {
                peerId,
                answerType: answer.type
            });

            return {
                peerId,
                answer: {
                    type: answer.type,
                    sdp: answer.sdp
                },
                timestamp: Date.now()
            };

        } catch (error) {
            this.log.error('Failed to create connection answer', {
                peerId,
                error: error.message
            });
            this._cleanupFailedConnection(peerId);
            throw error;
        }
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
     * Perform health check on connections
     * @returns {object} Health status
     */
    performHealthCheck() {
        const health = {
            timestamp: Date.now(),
            signalingConnected: this.signaling?.isConnected || false,
            totalPeers: this.connections.size,
            connectedPeers: this.connectedPeers.size,
            pendingConnections: this.pendingConnections.size,
            connectionStats: this.connectionStats,
            peerHealth: {}
        };

        for (const [peerId, peerConnection] of this.connections) {
            const state = peerConnection.connectionState;
            const iceState = peerConnection.iceConnectionState;
            const dataChannel = this.dataChannels.get(peerId);

            health.peerHealth[peerId] = {
                connectionState: state,
                iceConnectionState: iceState,
                dataChannelState: dataChannel?.readyState || 'none',
                isConnected: this.connectedPeers.has(peerId),
                lastActivity: Date.now() // Could track actual activity
            };

            // Emit health warnings
            if (state === 'failed' || iceState === 'failed') {
                this.emit('healthWarning', {
                    peerId,
                    issue: 'Connection failed',
                    state,
                    iceState
                });
            } else if (state === 'disconnected') {
                this.emit('healthWarning', {
                    peerId,
                    issue: 'Peer disconnected',
                    state
                });
            }
        }

        this.log.debug('Health check performed', health);
        return health;
    }

    /**
     * Start periodic health monitoring
     * @param {number} interval - Check interval in milliseconds
     */
    startHealthMonitoring(interval = 30000) {
        this.healthCheckInterval = setInterval(() => {
            this.performHealthCheck();
        }, interval);
        this.log.info('Health monitoring started', { interval });
    }

    /**
     * Stop health monitoring
     */
    stopHealthMonitoring() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
            this.log.info('Health monitoring stopped');
        }
    }

    /**
     * Clean up resources
     */
    cleanup() {
        this.stopAudioStreaming();
        this.disconnectAllPeers();

        // Close signaling connection
        if (this.signaling) {
            this.signaling.close();
        }

        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }

        this.emit('cleanup');
        this.log.info('WebRTC Audio Manager cleaned up');
    }
}

export { WebRTCAudioManager };