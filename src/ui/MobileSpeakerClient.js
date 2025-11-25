import { WebSocketSignaling } from '../core/network/WebSocketSignaling.js';

/**
 * Simple logger for mobile speaker
 */
class SimpleLogger {
    createScopedLogger(scope) {
        return {
            log: (message, data) => console.log(`[${new Date().toLocaleTimeString()}] ${scope}: ${message}`, data || ''),
            error: (message, data) => console.error(`[${new Date().toLocaleTimeString()}] ${scope} ERROR: ${message}`, data || ''),
            debug: (message, data) => console.debug(`[${new Date().toLocaleTimeString()}] ${scope} DEBUG: ${message}`, data || ''),
            info: (message, data) => console.info(`[${new Date().toLocaleTimeString()}] ${scope} INFO: ${message}`, data || '')
        };
    }
}

/**
 * Mobile Speaker Client
 * Connects to laptop and receives synchronized audio streams
 */
class MobileSpeakerClient {
    constructor() {
        this.logger = new SimpleLogger();
        this.log = this.logger.createScopedLogger('MobileSpeaker');
        this.peerConnection = null;
        this.dataChannel = null;
        this.audioElement = null;
        this.isConnected = false;
        this.deviceId = this._generateDeviceId();
        this.signaling = null;

        // UI elements
        this.elements = {
            connectBtn: document.getElementById('connectBtn'),
            statusIndicator: document.getElementById('statusIndicator'),
            connectionStatus: document.getElementById('connectionStatus'),
            deviceId: document.getElementById('deviceId'),
            connectionInfo: document.getElementById('connectionInfo'),
            audioLevelFill: document.getElementById('audioLevelFill'),
            volumeSlider: document.getElementById('volumeSlider'),
            testBtn: document.getElementById('testBtn'),
            muteBtn: document.getElementById('muteBtn'),
            audioInfo: document.getElementById('audioInfo')
        };

        this._initializeUI();
        this._setupSignaling();
        this._setupEventListeners();
    }

    _initializeUI() {
        this.elements.deviceId.textContent = this.deviceId.slice(-8);
        this._updateConnectionStatus('Ready to connect', false);
    }

    _setupSignaling() {
        const SIGNALING_SERVER_URL = 'wss://socketsbay.com/wss/v2/1/demo/';
        this.signaling = new WebSocketSignaling(SIGNALING_SERVER_URL);

        this.signaling.on('message', (data) => {
            this._handleSignalingMessage(data);
        });

        this.signaling.on('open', () => {
            this.log.info('Signaling connection opened.');
        });

        this.signaling.on('close', () => {
            this.log.warn('Signaling connection closed.');
            this._updateConnectionStatus('Signaling disconnected', true);
        });
    }

    _setupEventListeners() {
        this.elements.connectBtn.addEventListener('click', () => this._connectToLaptop());
        this.elements.volumeSlider.addEventListener('input', (e) => this._adjustVolume(e.target.value));
        this.elements.testBtn.addEventListener('click', () => this._playTestTone());
        this.elements.muteBtn.addEventListener('click', () => this._toggleMute());
    }

    _handleSignalingMessage(data) {
        this.log.log('Received signaling message', data);

        // Don't process messages from self
        if (data.senderId === this.deviceId) {
            return;
        }

        switch (data.type) {
            case 'webrtc-offer':
                this._handleConnectionOffer(data);
                break;
            case 'webrtc-offer-candidate':
                this._handleOfferIceCandidate(data);
                break;
            case 'webrtc-answer-accepted':
                this._updateConnectionStatus('Connection established!', false);
                break;
            default:
                this.log.debug('Unknown signaling message type', data.type);
        }
    }

    _generateDeviceId() {
        return 'mobile_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    async _connectToLaptop() {
        try {
            console.log('[DEBUG] Mobile speaker connect button clicked');
            this._updateConnectionStatus('Connecting...', false);
            this.elements.connectBtn.disabled = true;
            this.elements.connectBtn.innerHTML = 'Connecting... <span class="loading"></span>';

            // Check for WebRTC support
            if (!this._checkWebRTCSupport()) {
                throw new Error('WebRTC not supported in this browser');
            }

            // Connect to signaling server
            this.signaling.connect(this.deviceId);

            // Announce mobile device ready via WebSocket
            this.signaling.sendMessage({
                type: 'mobile-ready',
                timestamp: Date.now()
            });
            this.log.log('Announced mobile device ready');

            // Create peer connection
            console.log('[DEBUG] Creating RTCPeerConnection');
            this.peerConnection = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            });

            // Set up event handlers
            this.peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log('[DEBUG] Generated ICE candidate:', { type: event.candidate.type, candidate: event.candidate.candidate?.substring(0, 50) + '...' });
                    this.signaling.sendMessage({
                        type: 'webrtc-answer-candidate',
                        candidate: event.candidate
                    });
                }
            };

            this.peerConnection.ontrack = (event) => {
                console.log('[DEBUG] Received remote audio track');
                this._handleRemoteAudio(event.streams[0]);
            };

            this.peerConnection.ondatachannel = (event) => {
                console.log('[DEBUG] Received data channel');
                this.dataChannel = event.channel;
                this._setupDataChannel();
            };

            this.peerConnection.onconnectionstatechange = () => {
                console.log('[DEBUG] Connection state changed to:', this.peerConnection.connectionState);
                this._handleConnectionStateChange();
            };

            console.log('[DEBUG] Mobile speaker client initialized, waiting for offer from laptop');
            this.log.log('Mobile speaker client initialized, waiting for offer from laptop');

        } catch (error) {
            console.error('[DEBUG] Connection failed:', { error: error.message, stack: error.stack });
            this.log.error('Connection failed', { error: error.message });
            this._updateConnectionStatus(`Connection failed: ${error.message}`, true);
            this.elements.connectBtn.disabled = false;
            this.elements.connectBtn.innerHTML = '📱 Connect to Laptop';
        }
    }

    _checkWebRTCSupport() {
        return !!(
            window.RTCPeerConnection &&
            window.RTCSessionDescription &&
            window.RTCIceCandidate
        );
    }

    async _handleConnectionOffer(data) {
        try {
            console.log('[DEBUG] Handling connection offer from laptop:', { offerType: data.offer?.type });
            this.log.log('Received connection offer from laptop');

            // Validate offer format
            if (!data.offer || typeof data.offer !== 'object') {
                throw new Error('Invalid offer format: offer must be an object');
            }
            if (!data.offer.type || !data.offer.sdp) {
                throw new Error('Invalid offer format: missing type or sdp');
            }
            if (data.offer.type !== 'offer') {
                throw new Error(`Invalid offer type: expected 'offer', got '${data.offer.type}'`);
            }

            // Set remote description
            console.log('[DEBUG] Setting remote description');
            await this.peerConnection.setRemoteDescription(
                new RTCSessionDescription(data.offer)
            );
            console.log('[DEBUG] Remote description set successfully');

            // Create answer
            console.log('[DEBUG] Creating answer');
            const answer = await this.peerConnection.createAnswer();
            console.log('[DEBUG] Answer created:', { answerType: answer.type });
            await this.peerConnection.setLocalDescription(answer);
            console.log('[DEBUG] Local description set');

            // Send answer back to laptop
            const answerMessage = {
                type: 'webrtc-answer',
                answer: {
                    type: answer.type,
                    sdp: answer.sdp
                }
            };
            this.signaling.sendMessage(answerMessage);
            console.log('[DEBUG] Sent webrtc-answer message');

            this._updateConnectionStatus('Establishing connection...', false);

        } catch (error) {
            console.error('[DEBUG] Failed to handle connection offer:', { error: error.message, stack: error.stack });
            this.log.error('Failed to handle connection offer', { error: error.message });
            this._updateConnectionStatus(`Failed to connect: ${error.message}`, true);
        }
    }

    _setupDataChannel() {
        this.dataChannel.onopen = () => {
            this.log.log('Data channel opened');
            this._updateConnectionStatus('Connected to laptop!', false);
            this._setConnectedState(true);
        };

        this.dataChannel.onmessage = (event) => {
            this._handleDataChannelMessage(event.data);
        };

        this.dataChannel.onerror = (error) => {
            this.log.error('Data channel error', { error });
        };
    }

    _handleRemoteAudio(stream) {
        this.log.log('Received remote audio stream');
        
        // Create audio element
        this.audioElement = new Audio();
        this.audioElement.srcObject = stream;
        this.audioElement.autoplay = true;
        this.audioElement.volume = this.elements.volumeSlider.value / 100;
        
        // Set up audio level monitoring
        this.audioElement.addEventListener('play', () => {
            this._startAudioLevelMonitoring();
        });

        this.elements.audioInfo.textContent = 'Audio stream active';
        this.elements.audioInfo.className = 'info success';
    }

    _handleDataChannelMessage(data) {
        try {
            const message = JSON.parse(data);
            
            switch (message.type) {
                case 'ping':
                    this.dataChannel.send(JSON.stringify({ 
                        type: 'pong', 
                        timestamp: Date.now() 
                    }));
                    break;
                    
                case 'volumeControl':
                    this._adjustVolume(message.volume * 100);
                    break;
                    
                case 'testTone':
                    this._playTestTone();
                    break;
                    
                default:
                    this.log.debug('Unknown message received', { message });
            }
            
        } catch (error) {
            this.log.error('Failed to parse data channel message', { error: error.message });
        }
    }

    _handleConnectionStateChange() {
        const state = this.peerConnection.connectionState;
        
        switch (state) {
            case 'connected':
                this._setConnectedState(true);
                break;
            case 'disconnected':
            case 'failed':
                this._setConnectedState(false);
                this._updateConnectionStatus('Connection lost', true);
                break;
            case 'closed':
                this._setConnectedState(false);
                break;
        }
    }

    _setConnectedState(connected) {
        this.isConnected = connected;
        
        if (connected) {
            this.elements.statusIndicator.classList.add('connected');
            this.elements.connectBtn.style.display = 'none';
            this.elements.connectionInfo.textContent = 'Status: Connected';
        } else {
            this.elements.statusIndicator.classList.remove('connected');
            this.elements.connectBtn.style.display = 'block';
            this.elements.connectBtn.disabled = false;
            this.elements.connectBtn.innerHTML = '📱 Connect to Laptop';
            this.elements.connectionInfo.textContent = 'Status: Disconnected';
        }
    }

    _updateConnectionStatus(message, isError = false) {
        this.elements.connectionStatus.textContent = message;
        this.elements.connectionStatus.className = isError ? 'status error' : 'status';
    }

    _adjustVolume(volume) {
        this.elements.volumeSlider.value = volume;
        
        if (this.audioElement) {
            this.audioElement.volume = volume / 100;
        }
        
        // Send volume update to laptop if connected
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(JSON.stringify({
                type: 'volumeChanged',
                volume: volume / 100
            }));
        }
    }

    _playTestTone() {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.setValueAtTime(440, audioContext.currentTime);
        gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
        
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.5);
    }

    _toggleMute() {
        if (this.audioElement) {
            this.audioElement.muted = !this.audioElement.muted;
            this.elements.muteBtn.textContent = this.audioElement.muted ? '🔊 Unmute' : '🔇 Mute';
        }
    }

    _startAudioLevelMonitoring() {
        if (!this.audioElement) return;
        
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaElementSource(this.audioElement);
        
        source.connect(analyser);
        analyser.connect(audioContext.destination);
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        
        const updateLevel = () => {
            analyser.getByteFrequencyData(dataArray);
            const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
            const level = Math.round((average / 255) * 100);
            
            this.elements.audioLevelFill.style.width = level + '%';
            
            if (this.isConnected) {
                requestAnimationFrame(updateLevel);
            }
        };
        
        updateLevel();
    }

    _handleOfferIceCandidate(data) {
        const { peerId, candidate } = data;
        console.log('[DEBUG] Received ICE candidate from offerer:', { peerId, candidateType: candidate?.type, candidate: candidate?.candidate?.substring(0, 50) + '...' });
        this.log.debug(`Received ICE candidate from offerer: ${peerId}`);

        try {
            if (this.peerConnection && candidate) {
                // Reconstruct RTCIceCandidate from serialized data
                const iceCandidate = new RTCIceCandidate({
                    candidate: candidate.candidate,
                    sdpMid: candidate.sdpMid,
                    sdpMLineIndex: candidate.sdpMLineIndex,
                    usernameFragment: candidate.usernameFragment
                });
                this.peerConnection.addIceCandidate(iceCandidate);
                console.log('[DEBUG] ICE candidate added to peer connection successfully');
                this.log.debug('ICE candidate added to peer connection');
            } else {
                console.warn('[DEBUG] Cannot add ICE candidate - peerConnection or candidate missing');
            }
        } catch (error) {
            console.error('[DEBUG] Failed to add ICE candidate:', { error: error.message });
            this.log.error('Failed to add ICE candidate', { error: error.message });
        }
    }


    disconnect() {
        if (this.peerConnection) {
            this.peerConnection.close();
        }
        
        this._setConnectedState(false);
        this.log.log('Mobile speaker disconnected');
    }
}

// Initialize mobile speaker client when page loads
document.addEventListener('DOMContentLoaded', () => {
    new MobileSpeakerClient();
});