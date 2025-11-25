/**
 * Web Bluetooth Audio Synchronization System
 * Main entry point and system coordinator
 */

import { EventEmitter } from './core/utils/EventEmitter.js';
import { logger } from './core/utils/Logger.js';
import { MasterClock } from './core/clock/MasterClock.js';
import { DeviceClock } from './core/clock/DeviceClock.js';
import { DriftCorrection } from './core/clock/DriftCorrection.js';
import { DeviceManager } from './core/bluetooth/DeviceManager.js';
import { AudioSyncEngine } from './core/audio/AudioSyncEngine.js';
import { BufferManager } from './core/audio/BufferManager.js';
import { LatencyCompensation } from './core/audio/LatencyCompensation.js';
import { SystemAudioCapture } from './core/audio/SystemAudioCapture.js';
import { WebRTCAudioManager } from './core/network/WebRTCAudioManager.js';

/**
 * Main Web Bluetooth Audio Sync System
 */
class WebBluetoothAudioSync extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // System configuration
        this.config = {
            syncTolerance: options.syncTolerance || 1, // 1ms
            bufferSize: options.bufferSize || 2048,
            sampleRate: options.sampleRate || 44100,
            maxDevices: options.maxDevices || 8,
            enableLogging: options.enableLogging !== false
        };
        
        // Core system components
        this.masterClock = new MasterClock({
            tickInterval: 10,
            lookahead: 100,
            syncTolerance: this.config.syncTolerance
        });
        
        this.deviceManager = new DeviceManager({
            autoReconnect: true,
            maxConcurrentConnections: 3,
            connectionTimeout: 10000
        });
        
        this.driftCorrection = new DriftCorrection({
            driftThreshold: 0.5,
            correctionInterval: 100,
            maxCorrection: 2
        });
        
        this.audioSyncEngine = new AudioSyncEngine({
            syncTolerance: this.config.syncTolerance,
            bufferSize: this.config.bufferSize,
            sampleRate: this.config.sampleRate
        });
        
        this.bufferManager = new BufferManager({
            bufferSize: this.config.bufferSize,
            sampleRate: this.config.sampleRate
        });
        
        this.latencyCompensation = new LatencyCompensation();
        
        // System audio capture for dual output
        this.systemAudioCapture = new SystemAudioCapture({
            sampleRate: this.config.sampleRate,
            bufferSize: this.config.bufferSize,
            monitorVolume: true // Keep system audio playing through laptop speakers
        });
        
        // WebRTC audio streaming for mobile device connectivity
        this.webrtcManager = new WebRTCAudioManager({
            sampleRate: this.config.sampleRate
        });
        
        // Device tracking
        this.deviceClocks = new Map(); // deviceId -> DeviceClock
        this.activeDevices = new Set();
        
        // Mobile device tracking
        this.mobilePeers = new Set();

        // BroadcastChannel for mobile signaling
        this.mobileBroadcastChannel = null;

        // Dual output configuration
        this.dualOutputMode = false;
        this.mobileOutputMode = false;
        this.localAudioOutput = true; // Always allow laptop speakers to play
        
        // System state
        this.isInitialized = false;
        this.isRunning = false;
        this.isSynchronized = false;
        
        // Performance monitoring
        this.systemStats = {
            startTime: null,
            totalDevices: 0,
            activeSyncSessions: 0,
            averageLatency: 0,
            syncAccuracy: 0
        };
        
        this.log = logger.createScopedLogger('WebBluetoothAudioSync');
        
        this._initializeSystem();
    }

    /**
     * Initialize the audio synchronization system
     */
    async initialize() {
        if (this.isInitialized) {
            this.log.warn('System already initialized');
            return;
        }
        
        this.log.info('Initializing Web Bluetooth Audio Sync System');
        
        try {
            // Validate environment
            await this._validateEnvironment();
            
            // Set up event handlers
            this._setupEventHandlers();
            
            // Start core components
            await this._startCoreComponents();
            
            this.isInitialized = true;
            this.systemStats.startTime = Date.now();
            
            this.log.info('System initialization completed successfully');
            this.emit('initialized');
            
        } catch (error) {
            this.log.error('System initialization failed', { error: error.message });
            this.emit('initializationError', { error });
            throw error;
        }
    }

    /**
     * Start the audio synchronization system
     */
    async start() {
        if (!this.isInitialized) {
            throw new Error('System must be initialized before starting');
        }
        
        if (this.isRunning) {
            this.log.warn('System already running');
            return;
        }
        
        this.log.info('Starting audio synchronization system');
        
        try {
            // Start master clock
            this.masterClock.start();
            
            // Start drift correction
            this.driftCorrection.start();
            
            // Start audio sync engine
            await this.audioSyncEngine.start();
            
            this.isRunning = true;
            
            this.log.info('Audio synchronization system started');
            this.emit('started');
            
        } catch (error) {
            this.log.error('Failed to start system', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop the audio synchronization system
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }
        
        this.log.info('Stopping audio synchronization system');
        
        try {
            // Stop system audio capture
            await this.stopSystemAudioCapture();
            
            // Stop mobile audio streaming
            await this.stopMobileAudioStreaming();
            
            // Disconnect all mobile peers
            await this.disconnectAllMobilePeers();
            
            // Stop all components
            this.masterClock.stop();
            this.driftCorrection.stop();
            await this.audioSyncEngine.stop();
            
            // Disconnect all devices
            await this._disconnectAllDevices();
            
            this.isRunning = false;
            this.isSynchronized = false;
            
            this.log.info('Audio synchronization system stopped');
            this.emit('stopped');
            
        } catch (error) {
            this.log.error('Error stopping system', { error: error.message });
        }
    }

    /**
     * Connect to audio devices
     * @param {Array} deviceConfigs - Array of device configurations
     * @returns {Promise<Array>} Connection results
     */
    async connectDevices(deviceConfigs) {
        this.log.info('Connecting to audio devices', { 
            deviceCount: deviceConfigs.length 
        });
        
        try {
            // Connect devices through DeviceManager
            const connectionResults = await this.deviceManager.connectMultipleDevices(
                deviceConfigs,
                { maxConcurrent: 3 }
            );
            
            // Process successful connections
            const successfulConnections = [];
            
            for (const result of connectionResults) {
                this.log.debug('Processing connection result', {
                    success: result.success,
                    hasDevice: !!result.device,
                    deviceId: result.device?.id || 'none',
                    configName: result.config?.name || 'unknown'
                });

                if (result.success) {
                    if (!result.device) {
                        this.log.error('Connection result success but device is undefined', {
                            result: JSON.stringify(result)
                        });
                        throw new Error('Device is undefined in successful connection result');
                    }
                    await this._setupDeviceSynchronization(result.device);
                    successfulConnections.push(result);
                } else {
                    this.log.warn('Device connection failed', {
                        deviceId: result.config?.name || 'unknown',
                        error: result.error
                    });
                }
            }
            
            this.log.info('Device connection process completed', {
                total: deviceConfigs.length,
                successful: successfulConnections.length,
                failed: deviceConfigs.length - successfulConnections.length
            });
            
            this.emit('devicesConnected', { 
                results: connectionResults,
                successfulCount: successfulConnections.length
            });
            
            return connectionResults;
            
        } catch (error) {
            this.log.error('Device connection process failed', { error: error.message });
            throw error;
        }
    }

    /**
     * Start synchronized audio playback
     * @param {AudioBuffer} audioData - Audio data to play
     * @param {object} playbackOptions - Playback options
     * @returns {Promise<object>} Playback session
     */
    async startSynchronizedPlayback(audioData, playbackOptions = {}) {
        if (!this.isRunning) {
            throw new Error('System must be running to start playback');
        }
        
        if (this.activeDevices.size === 0) {
            throw new Error('No devices connected for synchronized playback');
        }
        
        this.log.info('Starting synchronized playback', {
            deviceCount: this.activeDevices.size,
            audioSize: audioData?.length || 0
        });
        
        try {
            // Create playback session
            const sessionId = this._generateSessionId();
            const session = {
                id: sessionId,
                audioData,
                options: playbackOptions,
                startTime: null,
                devices: new Set(this.activeDevices)
            };
            
            // Set up synchronization
            const masterStartTime = this.masterClock.getSyncTime();
            const syncPlan = await this.audioSyncEngine.createSyncPlan(
                audioData, 
                masterStartTime, 
                Array.from(this.activeDevices)
            );
            
            session.syncPlan = syncPlan;
            session.startTime = masterStartTime;
            
            // Start playback on all devices
            const playbackPromises = Array.from(this.activeDevices).map(deviceId =>
                this._startDevicePlayback(deviceId, session)
            );
            
            await Promise.all(playbackPromises);
            
            this.systemStats.activeSyncSessions++;
            this.isSynchronized = true;
            
            this.log.info('Synchronized playback started', { 
                sessionId, 
                deviceCount: this.activeDevices.size 
            });
            
            this.emit('playbackStarted', { 
                sessionId, 
                devices: Array.from(this.activeDevices),
                startTime: masterStartTime 
            });
            
            return session;
            
        } catch (error) {
            this.log.error('Failed to start synchronized playback', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop synchronized playback
     * @param {string} sessionId - Playback session identifier
     * @returns {Promise<boolean>} Success status
     */
    async stopSynchronizedPlayback(sessionId) {
        this.log.info('Stopping synchronized playback', { sessionId });
        
        try {
            // Stop playback on all devices
            const stopPromises = Array.from(this.activeDevices).map(deviceId =>
                this._stopDevicePlayback(deviceId, sessionId)
            );
            
            await Promise.all(stopPromises);
            
            this.systemStats.activeSyncSessions = Math.max(0, this.systemStats.activeSyncSessions - 1);
            
            if (this.systemStats.activeSyncSessions === 0) {
                this.isSynchronized = false;
            }
            
            this.log.info('Synchronized playback stopped', { sessionId });
            this.emit('playbackStopped', { sessionId });
            
            return true;
            
        } catch (error) {
            this.log.error('Error stopping playback', { sessionId, error: error.message });
            return false;
        }
    }

    /**
     * Get system status and statistics
     * @returns {object} System status
     */
    getSystemStatus() {
        try {
            return {
                initialized: this.isInitialized,
                running: this.isRunning,
                synchronized: this.isSynchronized,
                activeDevices: this.activeDevices.size,
                deviceClocks: Array.from(this.deviceClocks.keys()),
                masterClock: this.masterClock.getStats(),
                deviceManager: this.deviceManager.getConnectionStats(),
                driftCorrection: this.driftCorrection.getStats(),
                audioSync: this.audioSyncEngine.getStats(),
                bufferManager: this.bufferManager.getStats(),
                latencyCompensation: this.latencyCompensation.getStats(),
                systemAudioCapture: {
                    isSupported: this.systemAudioCapture.isSupported(),
                    isCapturing: this.systemAudioCapture.getIsCapturing(),
                    bufferStatus: this.systemAudioCapture.getBufferStatus(),
                    stats: this.systemAudioCapture.getStats()
                },
                webrtcManager: this.webrtcManager.getStats(),
                mobileConnectivity: this.getMobileConnectivityStatus(),
                dualOutputMode: this.dualOutputMode,
                mobileOutputMode: this.mobileOutputMode,
                localAudioOutput: this.localAudioOutput,
                systemStats: { ...this.systemStats },
                configuration: { ...this.config }
            };
        } catch (error) {
            this.log.error('Error getting system status', { error: error.message });
            // Return basic status on error
            return {
                initialized: this.isInitialized,
                running: this.isRunning,
                synchronized: this.isSynchronized,
                activeDevices: this.activeDevices.size,
                error: error.message
            };
        }
    }

    /**
     * Enable dual output mode (laptop speakers + connected devices)
     * @param {boolean} enable - Enable dual output
     */
    async enableDualOutput(enable = true) {
        try {
            this.dualOutputMode = enable;

            if (enable) {
                this.log.info('Enabling dual output mode');
                this.emit('dualOutputEnabled');
            } else {
                this.log.info('Disabling dual output mode');
                await this.disableSystemAudioCapture();
                this.emit('dualOutputDisabled');
            }
        } catch (error) {
            this.log.error('Error enabling dual output:', error);
        }
    }

    /**
     * Check if system audio capture is supported
     * @returns {boolean} True if supported
     */
    isSystemAudioCaptureSupported() {
        return this.systemAudioCapture.isSupported();
    }

    /**
     * Request permission for system audio capture
     * @returns {Promise<boolean>} True if permission granted
     */
    async requestSystemAudioPermission() {
        if (!this.systemAudioCapture.isSupported()) {
            throw new Error('System audio capture not supported on this browser');
        }

        try {
            const granted = await this.systemAudioCapture.requestPermission();
            if (granted) {
                this.emit('systemAudioPermissionGranted');
            }
            return granted;
        } catch (error) {
            this.emit('systemAudioPermissionDenied', { error });
            throw error;
        }
    }

    /**
     * Start capturing system audio for dual output
     * @returns {Promise<void>}
     */
    async startSystemAudioCapture() {
        if (!this.dualOutputMode) {
            alert("Please enable dual output mode first to start system audio capture.");
            return;
        }

        if (!this.systemAudioCapture.getIsCapturing()) {
            try {
                await this.systemAudioCapture.startCapture();
                this.emit('systemAudioCaptureStarted');
                
                // Set up audio frame processing
                this.systemAudioCapture.on('audioFrame', (event) => {
                    this._processSystemAudioFrame(event);
                });
                
                this.log.info('System audio capture started for dual output');
                
            } catch (error) {
                this.log.error('Failed to start system audio capture', { error: error.message });
                throw error;
            }
        }
    }

    /**
     * Stop capturing system audio
     */
    async stopSystemAudioCapture() {
        if (this.systemAudioCapture.getIsCapturing()) {
            this.systemAudioCapture.stopCapture();
            this.emit('systemAudioCaptureStopped');
            this.log.info('System audio capture stopped');
        }
    }

    /**
     * Disable system audio capture completely
     */
    async disableSystemAudioCapture() {
        await this.stopSystemAudioCapture();
        this.dualOutputMode = false;
        this.emit('systemAudioCaptureDisabled');
    }

    /**
     * Process system audio frame for synchronization
     * @param {object} audioFrame - Audio frame data
     * @private
     */
    _processSystemAudioFrame(audioFrame) {
        // Add to buffer manager for synchronization
        if (this.activeDevices.size > 0) {
            const deviceIds = Array.from(this.activeDevices);
            
            for (const deviceId of deviceIds) {
                // Send the same audio frame to all connected devices
                this.bufferManager.writeAudioData(
                    deviceId,
                    audioFrame.data.buffer,
                    audioFrame.timestamp
                );
            }
        }
        
        this.emit('systemAudioFrameProcessed', audioFrame);
    }

    /**
     * Start synchronized playback with system audio
     * @param {object} playbackOptions - Playback options
     * @returns {Promise<object>} Playback session
     */
    async startSynchronizedSystemAudioPlayback(playbackOptions = {}) {
        if (!this.dualOutputMode) {
            throw new Error('Dual output mode must be enabled');
        }

        if (!this.systemAudioCapture.isSupported()) {
            throw new Error('System audio capture not supported');
        }

        this.log.info('Starting synchronized system audio playback');

        try {
            // Ensure system audio is being captured
            if (!this.systemAudioCapture.getIsCapturing()) {
                await this.startSystemAudioCapture();
            }

            // Start audio sync engine if not running
            if (!this.audioSyncEngine.isRunning) {
                await this.audioSyncEngine.start();
            }

            // Create playback session
            const sessionId = this._generateSessionId();
            const session = {
                id: sessionId,
                type: 'system_audio',
                options: playbackOptions,
                startTime: null,
                devices: new Set(this.activeDevices)
            };

            // Set up synchronization for all devices
            const masterStartTime = this.masterClock.getSyncTime();
            
            // Add a "virtual device" representing the system audio source
            const systemDeviceId = 'system_audio_source';
            this.audioSyncEngine.addDevice(systemDeviceId);

            session.startTime = masterStartTime;
            session.systemDeviceId = systemDeviceId;

            this.systemStats.activeSyncSessions++;
            this.isSynchronized = true;

            this.log.info('Synchronized system audio playback started', { 
                sessionId, 
                deviceCount: this.activeDevices.size 
            });

            this.emit('systemAudioPlaybackStarted', { 
                sessionId, 
                devices: Array.from(this.activeDevices),
                startTime: masterStartTime 
            });

            return session;

        } catch (error) {
            this.log.error('Failed to start synchronized system audio playback', { error: error.message });
            throw error;
        }
    }

    /**
     * Stop synchronized system audio playback
     * @param {string} sessionId - Playback session identifier
     * @returns {Promise<boolean>} Success status
     */
    async stopSynchronizedSystemAudioPlayback(sessionId) {
        this.log.info('Stopping synchronized system audio playback', { sessionId });

        try {
            // Stop system audio capture
            await this.stopSystemAudioCapture();

            this.systemStats.activeSyncSessions = Math.max(0, this.systemStats.activeSyncSessions - 1);

            if (this.systemStats.activeSyncSessions === 0) {
                this.isSynchronized = false;
            }

            this.log.info('Synchronized system audio playback stopped', { sessionId });
            this.emit('systemAudioPlaybackStopped', { sessionId });

            return true;

        } catch (error) {
            this.log.error('Error stopping system audio playback', { sessionId, error: error.message });
            return false;
        }
    }

    /**
     * Enable mobile output mode for tablet/phone connectivity
     * @param {boolean} enable - Enable mobile output
     */
    async enableMobileOutput(enable = true) {
        this.mobileOutputMode = enable;
        
        if (enable) {
            this.log.info('Enabling mobile output mode');
            this.emit('mobileOutputEnabled');
        } else {
            this.log.info('Disabling mobile output mode');
            await this.disconnectAllMobilePeers();
            this.emit('mobileOutputDisabled');
        }
    }

    /**
     * Check if WebRTC is supported for mobile connectivity
     * @returns {boolean} True if supported
     */
    isWebRTCSupported() {
        return this.webrtcManager.isSupported();
    }

    /**
     * Create connection offer for a mobile peer
     * @param {string} peerId - Mobile device identifier
     * @returns {Promise<object>} Connection offer
     */
    async createMobileConnectionOffer(peerId) {
        if (!this.mobileOutputMode) {
            throw new Error('Mobile output mode must be enabled first');
        }

        if (!this.webrtcManager.isSupported()) {
            throw new Error('WebRTC not supported on this device');
        }

        try {
            this.log.info('Creating mobile connection offer', { peerId });
            
            const offerData = await this.webrtcManager.createConnectionOffer(peerId);
            
            this.emit('mobileConnectionOfferCreated', { peerId, offerData });
            
            return offerData;
            
        } catch (error) {
            this.log.error('Failed to create mobile connection offer', { 
                peerId, 
                error: error.message 
            });
            throw error;
        }
    }

    /**
     * Accept connection answer from mobile peer
     * @param {string} peerId - Mobile device identifier
     * @param {object} answer - Connection answer data
     * @returns {Promise<void>}
     */
    async acceptMobileConnectionAnswer(peerId, answer) {
        try {
            await this.webrtcManager.acceptConnectionAnswer(peerId, answer);

            this.mobilePeers.add(peerId);

            this.emit('mobilePeerConnected', { peerId });

            this.log.info('Mobile peer connected', { peerId });

        } catch (error) {
            this.log.error('Failed to accept mobile connection answer', {
                peerId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Add ICE candidate from mobile peer
     * @param {string} peerId - Mobile device identifier
     * @param {object} candidate - ICE candidate data
     * @returns {Promise<void>}
     */
    async addMobileIceCandidate(peerId, candidate) {
        try {
            await this.webrtcManager.addIceCandidate(peerId, candidate);

            this.log.debug('Mobile ICE candidate added', { peerId });

        } catch (error) {
            this.log.error('Failed to add mobile ICE candidate', {
                peerId,
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Start streaming system audio to all mobile peers
     * @returns {Promise<void>}
     */
    async startMobileAudioStreaming() {
        if (!this.mobileOutputMode) {
            throw new Error('Mobile output mode must be enabled first');
        }

        try {
            // Ensure system audio is being captured
            if (!this.systemAudioCapture.getIsCapturing()) {
                await this.startSystemAudioCapture();
            }

            // Get audio stream from system capture
            const audioStream = await this._createAudioStreamFromSystemCapture();

            // Start streaming to all mobile peers
            await this.webrtcManager.startAudioStreaming(audioStream);

            this.emit('mobileAudioStreamingStarted');
            
            this.log.info('Started mobile audio streaming', { 
                peerCount: this.mobilePeers.size 
            });

        } catch (error) {
            this.log.error('Failed to start mobile audio streaming', { 
                error: error.message 
            });
            throw error;
        }
    }

    /**
     * Stop streaming audio to mobile peers
     */
    async stopMobileAudioStreaming() {
        try {
            this.webrtcManager.stopAudioStreaming();
            
            this.emit('mobileAudioStreamingStopped');
            
            this.log.info('Stopped mobile audio streaming');
            
        } catch (error) {
            this.log.error('Failed to stop mobile audio streaming', { 
                error: error.message 
            });
        }
    }

    /**
     * Disconnect specific mobile peer
     * @param {string} peerId - Mobile device identifier
     */
    async disconnectMobilePeer(peerId) {
        try {
            this.webrtcManager.disconnectPeer(peerId);
            this.mobilePeers.delete(peerId);
            
            this.emit('mobilePeerDisconnected', { peerId });
            
            this.log.info('Mobile peer disconnected', { peerId });
            
        } catch (error) {
            this.log.error('Failed to disconnect mobile peer', { 
                peerId, 
                error: error.message 
            });
        }
    }

    /**
     * Disconnect all mobile peers
     */
    async disconnectAllMobilePeers() {
        for (const peerId of this.mobilePeers) {
            await this.disconnectMobilePeer(peerId);
        }
    }

    /**
     * Create audio stream from system audio capture
     * @returns {Promise<MediaStream>} Audio stream
     * @private
     */
    async _createAudioStreamFromSystemCapture() {
        // This is a simplified implementation
        // In a real scenario, you'd create a MediaStream from the captured audio
        try {
            this.log.debug('Creating audio stream from system capture', {
                hasAudioContext: !!window.AudioContext,
                hasWebkitAudioContext: !!window.webkitAudioContext
            });

            const AudioContextClass = window.AudioContext || window.webkitAudioContext;

            if (!AudioContextClass) {
                throw new Error('AudioContext not available for stream creation');
            }

            let audioContext;
            try {
                audioContext = new AudioContextClass();
            } catch (error) {
                this.log.error('Failed to create AudioContext in stream creation', {
                    error: error.message,
                    AudioContextClass: AudioContextClass.name
                });
                throw new Error(`AudioContext construction failed: ${error.message}`);
            }

            const destination = audioContext.createMediaStreamDestination();

            // Resume AudioContext if it's suspended (required in modern browsers)
            if (audioContext.state === 'suspended') {
                try {
                    await audioContext.resume();
                    this.log.debug('AudioContext resumed successfully', {
                        state: audioContext.state
                    });
                } catch (resumeError) {
                    this.log.warn('Failed to resume AudioContext', {
                        error: resumeError.message,
                        state: audioContext.state
                    });
                    // Continue anyway, as some contexts may work suspended
                }
            }

            this.log.info('Audio stream created successfully', {
                audioContextState: audioContext.state,
                sampleRate: audioContext.sampleRate
            });

            // Connect the audio context to create a stream
            // This would need to be connected to the actual captured audio

            return destination.stream;
        } catch (error) {
            this.log.error('Failed to create audio stream', {
                error: error.message,
                errorName: error.name,
                stack: error.stack
            });
            throw error;
        }
    }

    /**
     * Get mobile connectivity status
     * @returns {object} Mobile connectivity status
     */
    getMobileConnectivityStatus() {
        return {
            mobileOutputMode: this.mobileOutputMode,
            webrtcSupported: this.webrtcManager.isSupported(),
            connectedPeers: Array.from(this.mobilePeers),
            totalPeers: this.mobilePeers.size,
            streaming: this.webrtcManager.isStreaming,
            stats: this.webrtcManager.getStats()
        };
    }

    /**
     * Get device synchronization quality
     * @returns {object} Synchronization quality metrics
     */
    getSynchronizationQuality() {
        if (this.deviceClocks.size === 0) {
            return {
                overall: 'unknown',
                message: 'No devices connected',
                devices: []
            };
        }
        
        const deviceQualities = [];
        
        for (const [deviceId, deviceClock] of this.deviceClocks) {
            const metrics = deviceClock.getQualityMetrics();
            deviceQualities.push({
                deviceId,
                ...metrics,
                clockStats: deviceClock.getStats()
            });
        }
        
        const averageAccuracy = deviceQualities.reduce((sum, d) => 
            sum + d.syncAccuracy, 0) / deviceQualities.length;
        
        let overallQuality;
        if (averageAccuracy >= 95) {
            overallQuality = 'excellent';
        } else if (averageAccuracy >= 85) {
            overallQuality = 'good';
        } else if (averageAccuracy >= 70) {
            overallQuality = 'fair';
        } else {
            overallQuality = 'poor';
        }
        
        return {
            overall: overallQuality,
            averageAccuracy: Math.round(averageAccuracy),
            deviceCount: deviceQualities.length,
            devices: deviceQualities,
            systemQuality: this.driftCorrection.getSystemQuality(),
            dualOutputMode: this.dualOutputMode,
            systemAudioSupported: this.systemAudioCapture.isSupported()
        };
    }

    /**
     * Initialize the system components
     * @private
     */
    async _initializeSystem() {
        // Set up inter-component communication
        this._setupComponentCommunication();
    }

    /**
     * Validate the execution environment
     * @private
     */
    async _validateEnvironment() {
        // Check Web Bluetooth support
        if (!navigator.bluetooth) {
            throw new Error('Web Bluetooth is not supported in this browser');
        }
        
        // Check secure context (allow HTTP for testing)
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
            throw new Error('Web Bluetooth requires HTTPS or localhost');
        }
        
        // Check Web Audio support
        if (!window.AudioContext && !window.webkitAudioContext) {
            throw new Error('Web Audio API is not supported');
        }
        
        this.log.info('Environment validation passed');
    }

    /**
     * Start core system components
     * @private
     */
    async _startCoreComponents() {
        // Components will be started when start() is called
        this.log.info('Core components ready for startup');
    }

    /**
     * Set up event handlers between components
     * @private
     */
    _setupEventHandlers() {
        // Device Manager events
        this.deviceManager.on('deviceConnected', (event) => {
            this._handleDeviceConnected(event);
        });

        this.deviceManager.on('deviceDisconnected', (event) => {
            this._handleDeviceDisconnected(event);
        });

        // Master Clock events
        this.masterClock.on('tick', (event) => {
            this._handleMasterClockTick(event);
        });

        // Drift Correction events
        this.driftCorrection.on('correctionsApplied', (event) => {
            this._handleDriftCorrectionsApplied(event);
        });

        // System Audio Capture events
        this.systemAudioCapture.on('audioFrame', (event) => {
            // Audio frames are processed in _processSystemAudioFrame
        });

        // WebRTC Manager events
        this.webrtcManager.on('iceCandidate', (event) => {
            // Send ICE candidate to mobile peer via BroadcastChannel
            const { peerId, candidate } = event;
            // Serialize the RTCIceCandidate object for BroadcastChannel
            const serializedCandidate = candidate ? {
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid,
                sdpMLineIndex: candidate.sdpMLineIndex,
                usernameFragment: candidate.usernameFragment
            } : null;

            this._sendMobileBroadcastMessage({
                type: 'webrtc-offer-candidate',
                peerId,
                candidate: serializedCandidate
            });
            this.emit('iceCandidate', event);
        });

        this.webrtcManager.on('peerConnected', (event) => {
            this.emit('mobilePeerConnected', event);
        });

        this.webrtcManager.on('peerDisconnected', (event) => {
            this.emit('mobilePeerDisconnected', event);
        });

        // Set up BroadcastChannel for mobile signaling
        this._setupMobileBroadcastChannel();
    }

    /**
     * Set up component communication
     * @private
     */
    _setupComponentCommunication() {
        // Connect drift correction to device clocks
        this.driftCorrection.on('deviceAdded', (event) => {
            const deviceId = event.deviceId;
            const deviceClock = this.deviceClocks.get(deviceId);

            if (deviceClock) {
                this.driftCorrection.addDevice(deviceId, deviceClock);
            }
        });
    }

    /**
     * Set up BroadcastChannel for mobile device signaling
     * @private
     */
    _setupMobileBroadcastChannel() {
        if (typeof BroadcastChannel === 'undefined') {
            this.log.error('BroadcastChannel not supported in this browser');
            return;
        }

        this.mobileBroadcastChannel = new BroadcastChannel('syncplay-mobile');
        this.log.info('Mobile BroadcastChannel initialized');

        this.mobileBroadcastChannel.onmessage = (event) => {
            this._handleMobileBroadcastMessage(event.data);
        };
    }

    /**
     * Handle messages from mobile devices via BroadcastChannel
     * @param {object} data - Message data
     * @private
     */
    async _handleMobileBroadcastMessage(data) {
        this.log.info('Received mobile broadcast message', { type: data.type, peerId: data.peerId });

        // Detailed logging for debugging
        this.log.debug('Processing mobile broadcast message', {
            data: JSON.stringify(data),
            dataType: typeof data,
            hasType: !!data?.type,
            hasPeerId: !!data?.peerId
        });

        try {
            // Validate message format
            if (!data || typeof data !== 'object') {
                throw new Error('Invalid message format: data is not an object');
            }

            if (!data.type || typeof data.type !== 'string') {
                throw new Error('Invalid message format: missing or invalid type field');
            }

            switch (data.type) {
                case 'mobile-ready':
                    try {
                        this.log.debug('Handling mobile-ready message', { peerId: data.peerId });
                        await this._handleMobileReady(data);
                        this.log.debug('Successfully handled mobile-ready message', { peerId: data.peerId });
                    } catch (error) {
                        this.log.error('Error in handling mobile-ready message', {
                            peerId: data.peerId,
                            error: error.message,
                            stack: error.stack,
                            incomingMessageData: JSON.stringify(data)
                        });
                        throw error;
                    }
                    break;
                case 'webrtc-answer':
                    try {
                        this.log.debug('Handling webrtc-answer message', { peerId: data.peerId, answerType: data.answer?.type });
                        await this._handleWebRTCAnswer(data);
                        this.log.debug('Successfully handled webrtc-answer message', { peerId: data.peerId });
                    } catch (error) {
                        this.log.error('Error in handling webrtc-answer message', {
                            peerId: data.peerId,
                            error: error.message,
                            stack: error.stack,
                            incomingMessageData: JSON.stringify(data)
                        });
                        throw error;
                    }
                    break;
                case 'webrtc-answer-candidate':
                    try {
                        this.log.debug('Handling webrtc-answer-candidate message', { peerId: data.peerId, candidateType: data.candidate?.type });
                        await this._handleWebRTCAnswerCandidate(data);
                        this.log.debug('Successfully handled webrtc-answer-candidate message', { peerId: data.peerId });
                    } catch (error) {
                        this.log.error('Error in handling webrtc-answer-candidate message', {
                            peerId: data.peerId,
                            error: error.message,
                            stack: error.stack,
                            incomingMessageData: JSON.stringify(data)
                        });
                        throw error;
                    }
                    break;
                default:
                    this.log.warn('Unknown mobile broadcast message type', {
                        type: data.type,
                        fullData: JSON.stringify(data)
                    });
            }
        } catch (error) {
            this.log.error('Failed to handle mobile broadcast message', {
                type: data?.type || 'unknown',
                peerId: data?.peerId || 'unknown',
                error: error.message,
                stack: error.stack,
                incomingMessageData: JSON.stringify(data)
            });
        }
    }

    /**
     * Handle mobile device ready message
     * @param {object} data - Mobile ready data
     * @private
     */
    async _handleMobileReady(data) {
        const { peerId } = data;

        this.log.debug('Mobile ready message received', { peerId, mobileOutputMode: this.mobileOutputMode, data });

        if (!this.mobileOutputMode) {
            this.log.warn('Mobile ready received but mobile output mode not enabled', { peerId });
            return;
        }

        this.log.info('Mobile device ready, creating connection offer', { peerId });

        try {
            // Create WebRTC offer for the mobile peer
            this.log.debug('Calling createMobileConnectionOffer', { peerId });
            const offerData = await this.createMobileConnectionOffer(peerId);
            this.log.debug('WebRTC offer created successfully', { peerId, offerType: offerData.offer.type });

            // Send offer via BroadcastChannel
            this._sendMobileBroadcastMessage({
                type: 'webrtc-offer',
                peerId,
                offer: offerData.offer
            });

            this.log.info('WebRTC offer sent to mobile peer', { peerId });

        } catch (error) {
            this.log.error('Failed to create and send offer to mobile peer', {
                peerId,
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Handle WebRTC answer from mobile peer
     * @param {object} data - Answer data
     * @private
     */
    async _handleWebRTCAnswer(data) {
        const { peerId, answer } = data;

        this.log.debug('WebRTC answer received from mobile peer', { peerId, answerType: answer?.type });
        this.log.info('Received WebRTC answer from mobile peer', { peerId });

        try {
            this.log.debug('Calling acceptMobileConnectionAnswer', { peerId });
            await this.acceptMobileConnectionAnswer(peerId, answer);
            this.log.debug('WebRTC answer accepted successfully', { peerId });

            // Notify mobile that answer was accepted
            this._sendMobileBroadcastMessage({
                type: 'webrtc-answer-accepted',
                peerId
            });
            this.log.debug('Sent webrtc-answer-accepted message to peer', { peerId });

        } catch (error) {
            this.log.error('Failed to accept WebRTC answer', {
                peerId,
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Handle ICE candidate from mobile peer
     * @param {object} data - ICE candidate data
     * @private
     */
    async _handleWebRTCAnswerCandidate(data) {
        const { peerId, candidate } = data;

        this.log.debug('ICE candidate received from mobile peer', { peerId, candidateType: candidate?.type, candidateSnippet: candidate?.candidate?.substring(0, 50) + '...' });
        this.log.debug('Received ICE candidate from mobile peer', { peerId });

        try {
            this.log.debug('Calling addMobileIceCandidate', { peerId });
            await this.addMobileIceCandidate(peerId, candidate);
            this.log.debug('ICE candidate added successfully', { peerId });
        } catch (error) {
            this.log.error('Failed to add ICE candidate from mobile peer', {
                peerId,
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Send message to mobile devices via BroadcastChannel
     * @param {object} message - Message to send
     * @private
     */
    _sendMobileBroadcastMessage(message) {
        if (this.mobileBroadcastChannel) {
            this.mobileBroadcastChannel.postMessage(message);
            this.log.debug('Sent mobile broadcast message', { type: message.type, peerId: message.peerId });
        } else {
            this.log.error('Mobile BroadcastChannel not available');
        }
    }

    /**
     * Handle device connection
     * @param {object} event - Device connected event
     * @private
     */
    async _handleDeviceConnected(event) {
        const { device, deviceState } = event;
        const deviceId = device.id;
        
        this.log.debug('Setting up device synchronization', { deviceId });
        
        try {
            await this._setupDeviceSynchronization(device);
            
        } catch (error) {
            this.log.error('Failed to setup device synchronization', { 
                deviceId, 
                error: error.message 
            });
        }
    }

    /**
     * Set up synchronization for a connected device
     * @param {object} device - Bluetooth device
     * @private
     */
    async _setupDeviceSynchronization(device) {
        const deviceId = device.id;
        
        // Create device clock
        const deviceClock = new DeviceClock(deviceId, {
            syncTolerance: this.config.syncTolerance
        });
        
        this.deviceClocks.set(deviceId, deviceClock);
        this.activeDevices.add(deviceId);
        
        // Add to drift correction
        this.driftCorrection.addDevice(deviceId, deviceClock);
        
        // Measure initial latency
        await this._measureDeviceLatency(deviceId);
        
        this.systemStats.totalDevices = this.deviceClocks.size;
        
        this.log.info('Device synchronization setup completed', { 
            deviceId, 
            totalDevices: this.deviceClocks.size 
        });
        
        this.emit('deviceSynchronized', { deviceId, deviceClock });
    }

    /**
     * Handle device disconnection
     * @param {object} event - Device disconnected event
     * @private
     */
    _handleDeviceDisconnected(event) {
        const { deviceId } = event;
        
        // Remove device clock
        this.deviceClocks.delete(deviceId);
        this.activeDevices.delete(deviceId);
        
        // Remove from drift correction
        this.driftCorrection.removeDevice(deviceId);
        
        this.systemStats.totalDevices = this.deviceClocks.size;
        
        this.log.info('Device removed from synchronization', { 
            deviceId, 
            remainingDevices: this.deviceClocks.size 
        });
        
        this.emit('deviceDesynchronized', { deviceId });
    }

    /**
     * Handle master clock ticks for synchronization
     * @param {object} event - Tick event
     * @private
     */
    _handleMasterClockTick(event) {
        const { time, tickCount } = event;
        
        // Perform drift correction
        if (tickCount % 10 === 0) { // Every 100ms (10ms * 10)
            this.driftCorrection.performCorrection(time);
        }
        
        // Update system statistics
        this._updateSystemStats(time);
    }

    /**
     * Handle drift corrections applied
     * @param {object} event - Drift correction event
     * @private
     */
    _handleDriftCorrectionsApplied(event) {
        const { corrections } = event;
        
        // Update device quality based on corrections
        corrections.forEach(correction => {
            const { deviceId, quality } = correction;
            this.deviceManager.setDeviceQuality(deviceId, quality);
        });
        
        this.emit('synchronizationUpdated', event);
    }

    /**
     * Measure device latency
     * @param {string} deviceId - Device identifier
     * @private
     */
    async _measureDeviceLatency(deviceId) {
        try {
            // Perform latency measurement
            const latency = await this.latencyCompensation.measureLatency(deviceId);
            
            // Update device clock with latency information
            const deviceClock = this.deviceClocks.get(deviceId);
            if (deviceClock) {
                deviceClock.setConfig({ measurementTimeout: Math.max(latency * 3, 100) });
            }
            
        } catch (error) {
            this.log.warn('Failed to measure device latency', { deviceId, error: error.message });
        }
    }

    /**
     * Start playback on a specific device
     * @param {string} deviceId - Device identifier
     * @param {object} session - Playback session
     * @private
     */
    async _startDevicePlayback(deviceId, session) {
        // Implementation would send audio data to the device
        // This is a placeholder for the actual device-specific playback logic
        this.log.debug('Starting playback on device', { deviceId, sessionId: session.id });
    }

    /**
     * Stop playback on a specific device
     * @param {string} deviceId - Device identifier
     * @param {string} sessionId - Session identifier
     * @private
     */
    async _stopDevicePlayback(deviceId, sessionId) {
        // Implementation would stop audio on the specific device
        this.log.debug('Stopping playback on device', { deviceId, sessionId });
    }

    /**
     * Disconnect all connected devices
     * @private
     */
    async _disconnectAllDevices() {
        const disconnectPromises = Array.from(this.activeDevices).map(deviceId =>
            this.deviceManager.disconnectDevice(deviceId)
        );
        
        await Promise.all(disconnectPromises);
    }

    /**
     * Update system statistics
     * @param {number} currentTime - Current time
     * @private
     */
    _updateSystemStats(currentTime) {
        // Calculate average latency across devices
        let totalLatency = 0;
        let deviceCount = 0;
        
        for (const deviceClock of this.deviceClocks.values()) {
            const stats = deviceClock.getStats();
            if (stats.latency > 0) {
                totalLatency += stats.latency;
                deviceCount++;
            }
        }
        
        this.systemStats.averageLatency = deviceCount > 0 ? totalLatency / deviceCount : 0;
        
        // Calculate sync accuracy
        const quality = this.getSynchronizationQuality();
        this.systemStats.syncAccuracy = quality.averageAccuracy;
    }

    /**
     * Generate unique session ID
     * @returns {string} Session identifier
     * @private
     */
    _generateSessionId() {
        return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

// Export for use in browser and modules
export { WebBluetoothAudioSync };

// Make available globally for script tag usage
if (typeof window !== 'undefined') {
    window.WebBluetoothAudioSync = WebBluetoothAudioSync;
}