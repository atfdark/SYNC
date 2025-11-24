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
        
        // Device tracking
        this.deviceClocks = new Map(); // deviceId -> DeviceClock
        this.activeDevices = new Set();
        
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
                if (result.success) {
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
            systemStats: { ...this.systemStats },
            configuration: { ...this.config }
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
            systemQuality: this.driftCorrection.getSystemQuality()
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
        
        // Check secure context
        if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
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