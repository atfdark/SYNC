import { EventEmitter } from '../utils/EventEmitter.js';
import { TimeUtils } from '../utils/TimeUtils.js';
import { logger } from '../utils/Logger.js';

/**
 * AudioSyncEngine handles audio timing and synchronization across multiple devices
 */
class AudioSyncEngine extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Configuration
        this.syncTolerance = options.syncTolerance || 1; // 1ms
        this.bufferSize = options.bufferSize || 2048;
        this.sampleRate = options.sampleRate || 44100;
        this.lookaheadTime = options.lookaheadTime || 100; // 100ms
        this.adjustmentSmoothing = options.adjustmentSmoothing || 0.1;
        
        // Synchronization state
        this.isRunning = false;
        this.activeDevices = new Set();
        this.syncPlans = new Map(); // deviceId -> sync plan
        this.bufferQueues = new Map(); // deviceId -> audio buffer queue
        
        // Master timing
        this.playbackStartTime = null;
        this.currentPlaybackPosition = 0;
        this.totalPlaybackDuration = 0;
        
        // Performance tracking
        this.syncStats = {
            totalSyncOperations: 0,
            successfulSyncs: 0,
            failedSyncs: 0,
            averageSyncAccuracy: 0,
            lastSyncTime: null
        };
        
        this.log = logger.createScopedLogger('AudioSyncEngine');
    }

    /**
     * Start the audio synchronization engine
     */
    async start() {
        if (this.isRunning) {
            this.log.warn('Audio sync engine is already running');
            return;
        }
        
        this.log.info('Starting audio synchronization engine');
        
        this.isRunning = true;
        
        // Start synchronization loop
        this._startSyncLoop();
        
        this.emit('started');
        this.log.info('Audio synchronization engine started');
    }

    /**
     * Stop the audio synchronization engine
     */
    async stop() {
        if (!this.isRunning) {
            return;
        }
        
        this.log.info('Stopping audio synchronization engine');
        
        this.isRunning = false;
        
        // Clear all sync plans and buffers
        this.syncPlans.clear();
        this.bufferQueues.clear();
        this.activeDevices.clear();
        
        this.emit('stopped');
        this.log.info('Audio synchronization engine stopped');
    }

    /**
     * Add a device to the synchronization group
     * @param {string} deviceId - Device identifier
     */
    addDevice(deviceId) {
        if (this.activeDevices.has(deviceId)) {
            this.log.warn('Device already added to sync group', { deviceId });
            return;
        }
        
        this.activeDevices.add(deviceId);
        this.bufferQueues.set(deviceId, []);
        this.syncPlans.set(deviceId, this._createEmptySyncPlan(deviceId));
        
        this.log.debug('Device added to sync group', { deviceId });
        this.emit('deviceAdded', { deviceId });
    }

    /**
     * Remove a device from the synchronization group
     * @param {string} deviceId - Device identifier
     */
    removeDevice(deviceId) {
        if (!this.activeDevices.has(deviceId)) {
            return;
        }
        
        this.activeDevices.delete(deviceId);
        this.bufferQueues.delete(deviceId);
        this.syncPlans.delete(deviceId);
        
        this.log.debug('Device removed from sync group', { deviceId });
        this.emit('deviceRemoved', { deviceId });
    }

    /**
     * Create a synchronization plan for playback
     * @param {ArrayBuffer} audioData - Audio data to synchronize
     * @param {number} masterStartTime - Master clock start time
     * @param {Array} deviceIds - Array of device IDs
     * @returns {object} Synchronization plan
     */
    async createSyncPlan(audioData, masterStartTime, deviceIds) {
        this.log.info('Creating synchronization plan', {
            masterStartTime,
            deviceCount: deviceIds.length
        });
        
        const syncPlan = {
            id: this._generatePlanId(),
            masterStartTime,
            audioData,
            devicePlans: new Map(),
            createdAt: Date.now()
        };
        
        // Create individual device sync plans
        for (const deviceId of deviceIds) {
            if (!this.activeDevices.has(deviceId)) {
                this.addDevice(deviceId);
            }
            
            const devicePlan = this._createDeviceSyncPlan(
                deviceId, 
                audioData, 
                masterStartTime
            );
            
            syncPlan.devicePlans.set(deviceId, devicePlan);
            this.syncPlans.set(deviceId, devicePlan);
        }
        
        this.log.info('Synchronization plan created', {
            planId: syncPlan.id,
            deviceCount: deviceIds.length
        });
        
        this.emit('syncPlanCreated', { plan: syncPlan });
        
        return syncPlan;
    }

    /**
     * Synchronize audio playback across all devices
     * @param {string} planId - Synchronization plan identifier
     * @returns {Promise<object>} Synchronization result
     */
    async synchronizePlayback(planId) {
        if (!this.isRunning) {
            throw new Error('Audio sync engine is not running');
        }
        
        this.log.info('Starting synchronized playback', { planId });
        
        const results = [];
        
        // Synchronize each device according to the plan
        for (const [deviceId, syncPlan] of this.syncPlans) {
            try {
                const result = await this._synchronizeDevicePlayback(deviceId, syncPlan);
                results.push(result);
                
                if (result.success) {
                    this.syncStats.successfulSyncs++;
                } else {
                    this.syncStats.failedSyncs++;
                }
                
            } catch (error) {
                this.log.error('Device synchronization failed', {
                    deviceId,
                    error: error.message
                });
                
                results.push({
                    deviceId,
                    success: false,
                    error: error.message
                });
                
                this.syncStats.failedSyncs++;
            }
        }
        
        this.syncStats.totalSyncOperations++;
        this.syncStats.lastSyncTime = Date.now();
        
        this.emit('playbackSynchronized', { planId, results });
        
        this.log.info('Playback synchronization completed', {
            planId,
            successful: results.filter(r => r.success).length,
            failed: results.filter(r => !r.success).length
        });
        
        return { planId, results };
    }

    /**
     * Update audio buffer for a specific device
     * @param {string} deviceId - Device identifier
     * @param {ArrayBuffer} audioData - Audio data buffer
     * @param {number} timestamp - Timestamp for the audio data
     */
    updateDeviceBuffer(deviceId, audioData, timestamp) {
        if (!this.bufferQueues.has(deviceId)) {
            this.log.warn('Device buffer not found', { deviceId });
            return;
        }
        
        const buffer = {
            data: audioData,
            timestamp,
            size: audioData.byteLength,
            sampleRate: this.sampleRate
        };
        
        const queue = this.bufferQueues.get(deviceId);
        queue.push(buffer);
        
        // Maintain buffer size
        if (queue.length > 10) { // Keep last 10 buffers
            queue.shift();
        }
        
        this.emit('bufferUpdated', { deviceId, buffer });
    }

    /**
     * Get current synchronization status
     * @returns {object} Synchronization status
     */
    getSyncStatus() {
        const deviceStatuses = new Map();
        
        for (const deviceId of this.activeDevices) {
            const queue = this.bufferQueues.get(deviceId) || [];
            const syncPlan = this.syncPlans.get(deviceId);
            
            deviceStatuses.set(deviceId, {
                deviceId,
                bufferCount: queue.length,
                hasSyncPlan: !!syncPlan,
                lastUpdate: queue.length > 0 ? queue[queue.length - 1].timestamp : null,
                quality: this._assessDeviceQuality(deviceId)
            });
        }
        
        return {
            isRunning: this.isRunning,
            activeDevices: this.activeDevices.size,
            deviceStatuses: Object.fromEntries(deviceStatuses),
            playbackStartTime: this.playbackStartTime,
            currentPosition: this.currentPlaybackPosition,
            totalDuration: this.totalPlaybackDuration,
            stats: { ...this.syncStats }
        };
    }

    /**
     * Calculate synchronization accuracy for all devices
     * @returns {object} Accuracy metrics
     */
    getSyncAccuracy() {
        if (this.activeDevices.size === 0) {
            return {
                overall: 0,
                averageDeviation: 0,
                devices: []
            };
        }
        
        const deviceAccuracies = [];
        
        for (const deviceId of this.activeDevices) {
            const accuracy = this._calculateDeviceAccuracy(deviceId);
            deviceAccuracies.push(accuracy);
        }
        
        const totalAccuracy = deviceAccuracies.reduce((sum, acc) => sum + acc.accuracy, 0);
        const overallAccuracy = totalAccuracy / deviceAccuracies.length;
        
        // Update running average
        const alpha = 0.1;
        this.syncStats.averageSyncAccuracy = 
            alpha * overallAccuracy + (1 - alpha) * this.syncStats.averageSyncAccuracy;
        
        return {
            overall: Math.round(overallAccuracy),
            averageDeviation: deviceAccuracies.reduce((sum, acc) => sum + acc.deviation, 0) / deviceAccuracies.length,
            devices: deviceAccuracies,
            systemQuality: this._getSystemQuality(overallAccuracy)
        };
    }

    /**
     * Start the synchronization loop
     * @private
     */
    _startSyncLoop() {
        const syncLoop = () => {
            if (!this.isRunning) {
                return;
            }
            
            // Process synchronization for active playback sessions
            this._processActiveSync();
            
            // Schedule next iteration
            setTimeout(() => {
                requestAnimationFrame(syncLoop);
            }, 16); // ~60fps
        };
        
        requestAnimationFrame(syncLoop);
    }

    /**
     * Process active synchronization
     * @private
     */
    _processActiveSync() {
        const currentTime = performance.now();
        
        for (const [deviceId, syncPlan] of this.syncPlans) {
            if (syncPlan.started && !syncPlan.completed) {
                this._processDeviceSync(deviceId, syncPlan, currentTime);
            }
        }
    }

    /**
     * Create an empty synchronization plan for a device
     * @param {string} deviceId - Device identifier
     * @returns {object} Empty sync plan
     * @private
     */
    _createEmptySyncPlan(deviceId) {
        return {
            deviceId,
            started: false,
            completed: false,
            startTime: null,
            bufferAdjustments: [],
            syncPoints: [],
            lastAdjustment: 0
        };
    }

    /**
     * Create device-specific synchronization plan
     * @param {string} deviceId - Device identifier
     * @param {ArrayBuffer} audioData - Audio data
     * @param {number} masterStartTime - Master start time
     * @returns {object} Device sync plan
     * @private
     */
    _createDeviceSyncPlan(deviceId, audioData, masterStartTime) {
        const audioSamples = audioData.byteLength / (4 * 2); // Assuming stereo 32-bit float
        const audioDuration = audioSamples / this.sampleRate; // in seconds
        const audioDurationMs = audioDuration * 1000;
        
        const syncPlan = this._createEmptySyncPlan(deviceId);
        
        // Calculate device-specific adjustments
        const adjustments = this._calculateDeviceAdjustments(deviceId, audioDurationMs);
        
        syncPlan.masterStartTime = masterStartTime;
        syncPlan.audioDuration = audioDurationMs;
        syncPlan.bufferAdjustments = adjustments;
        syncPlan.targetStartTime = masterStartTime + adjustments.initialDelay;
        
        // Create synchronization points
        syncPlan.syncPoints = this._createSyncPoints(syncPlan.targetStartTime, audioDurationMs);
        
        return syncPlan;
    }

    /**
     * Calculate device-specific adjustments
     * @param {string} deviceId - Device identifier
     * @param {number} audioDuration - Audio duration in milliseconds
     * @returns {object} Device adjustments
     * @private
     */
    _calculateDeviceAdjustments(deviceId, audioDuration) {
        // Simulate device-specific latency and timing adjustments
        const deviceLatency = 10 + Math.random() * 20; // 10-30ms
        const clockOffset = (Math.random() - 0.5) * 2; // -1 to 1ms
        
        return {
            initialDelay: deviceLatency + clockOffset,
            bufferOffset: Math.round(deviceLatency * this.sampleRate / 1000),
            sampleRateOffset: 1 + (Math.random() - 0.5) * 0.001, // Small sample rate variance
            syncInterval: 100 // Resync every 100ms
        };
    }

    /**
     * Create synchronization points for playback
     * @param {number} startTime - Start time
     * @param {number} duration - Duration in milliseconds
     * @returns {Array} Sync points
     * @private
     */
    _createSyncPoints(startTime, duration) {
        const syncPoints = [];
        const interval = 1000; // Sync every second
        
        for (let time = startTime; time <= startTime + duration; time += interval) {
            syncPoints.push({
                timestamp: time,
                type: 'major', // Major sync point
                tolerance: this.syncTolerance
            });
        }
        
        return syncPoints;
    }

    /**
     * Synchronize playback for a specific device
     * @param {string} deviceId - Device identifier
     * @param {object} syncPlan - Device synchronization plan
     * @returns {Promise<object>} Sync result
     * @private
     */
    async _synchronizeDevicePlayback(deviceId, syncPlan) {
        const currentTime = performance.now();
        
        // Check if it's time to start playback
        if (!syncPlan.started && currentTime >= syncPlan.targetStartTime) {
            syncPlan.started = true;
            syncPlan.startTime = currentTime;
            
            this.log.debug('Device playback started', { deviceId, targetTime: syncPlan.targetStartTime });
            
            this.emit('devicePlaybackStarted', { deviceId, startTime: currentTime });
        }
        
        // Process ongoing synchronization
        if (syncPlan.started && !syncPlan.completed) {
            const syncResult = this._processDeviceSync(deviceId, syncPlan, currentTime);
            
            return {
                deviceId,
                success: syncResult.success,
                accuracy: syncResult.accuracy,
                adjustments: syncResult.adjustments
            };
        }
        
        return {
            deviceId,
            success: true,
            accuracy: 100,
            adjustments: 0
        };
    }

    /**
     * Process synchronization for a specific device
     * @param {string} deviceId - Device identifier
     * @param {object} syncPlan - Device sync plan
     * @param {number} currentTime - Current time
     * @returns {object} Processing result
     * @private
     */
    _processDeviceSync(deviceId, syncPlan, currentTime) {
        // Check for sync points
        const dueSyncPoints = syncPlan.syncPoints.filter(point => 
            Math.abs(point.timestamp - currentTime) <= point.tolerance
        );
        
        if (dueSyncPoints.length > 0) {
            const adjustment = this._calculateSyncAdjustment(deviceId, currentTime, syncPlan);
            
            if (Math.abs(adjustment) > 0.1) { // Only apply significant adjustments
                this._applySyncAdjustment(deviceId, adjustment, syncPlan);
            }
        }
        
        // Check if playback is complete
        if (currentTime >= syncPlan.startTime + syncPlan.audioDuration) {
            syncPlan.completed = true;
            this.emit('devicePlaybackCompleted', { deviceId });
        }
        
        return {
            success: true,
            accuracy: this._calculateDeviceAccuracy(deviceId).accuracy,
            adjustments: syncPlan.bufferAdjustments.length
        };
    }

    /**
     * Calculate synchronization adjustment for a device
     * @param {string} deviceId - Device identifier
     * @param {number} currentTime - Current time
     * @param {object} syncPlan - Device sync plan
     * @returns {number} Adjustment in milliseconds
     * @private
     */
    _calculateSyncAdjustment(deviceId, currentTime, syncPlan) {
        // Simulate timing drift measurement
        const expectedTime = syncPlan.startTime + (currentTime - syncPlan.startTime);
        const actualPosition = syncPlan.targetStartTime + (currentTime - syncPlan.targetStartTime);
        
        const drift = actualPosition - expectedTime;
        
        // Apply smoothing to prevent sudden changes
        const smoothedDrift = this.adjustmentSmoothing * drift + 
                             (1 - this.adjustmentSmoothing) * syncPlan.lastAdjustment;
        
        return smoothedDrift;
    }

    /**
     * Apply synchronization adjustment
     * @param {string} deviceId - Device identifier
     * @param {number} adjustment - Adjustment in milliseconds
     * @param {object} syncPlan - Device sync plan
     * @private
     */
    _applySyncAdjustment(deviceId, adjustment, syncPlan) {
        syncPlan.bufferAdjustments.push({
            timestamp: Date.now(),
            adjustment,
            reason: 'drift_correction'
        });
        
        syncPlan.lastAdjustment = adjustment;
        
        this.log.debug('Sync adjustment applied', {
            deviceId,
            adjustment,
            totalAdjustments: syncPlan.bufferAdjustments.length
        });
        
        this.emit('syncAdjustmentApplied', {
            deviceId,
            adjustment,
            totalAdjustments: syncPlan.bufferAdjustments.length
        });
    }

    /**
     * Assess device synchronization quality
     * @param {string} deviceId - Device identifier
     * @returns {string} Quality assessment
     * @private
     */
    _assessDeviceQuality(deviceId) {
        const syncPlan = this.syncPlans.get(deviceId);
        
        if (!syncPlan) return 'unknown';
        
        const adjustmentCount = syncPlan.bufferAdjustments.length;
        const avgAdjustment = syncPlan.bufferAdjustments.reduce((sum, adj) => 
            sum + Math.abs(adj.adjustment), 0) / (adjustmentCount || 1);
        
        if (adjustmentCount < 2 && avgAdjustment < 0.5) {
            return 'excellent';
        } else if (adjustmentCount < 5 && avgAdjustment < 1) {
            return 'good';
        } else if (avgAdjustment < 2) {
            return 'fair';
        } else {
            return 'poor';
        }
    }

    /**
     * Calculate device synchronization accuracy
     * @param {string} deviceId - Device identifier
     * @returns {object} Accuracy metrics
     * @private
     */
    _calculateDeviceAccuracy(deviceId) {
        const syncPlan = this.syncPlans.get(deviceId);
        
        if (!syncPlan) {
            return { deviceId, accuracy: 0, deviation: 0, quality: 'unknown' };
        }
        
        const totalAdjustments = syncPlan.bufferAdjustments.length;
        const totalDeviation = syncPlan.bufferAdjustments.reduce((sum, adj) => 
            sum + Math.abs(adj.adjustment), 0);
        
        const averageDeviation = totalAdjustments > 0 ? totalDeviation / totalAdjustments : 0;
        const accuracy = Math.max(0, 100 - (averageDeviation * 10)); // Convert to percentage
        
        return {
            deviceId,
            accuracy: Math.round(accuracy),
            deviation: averageDeviation,
            quality: this._assessDeviceQuality(deviceId)
        };
    }

    /**
     * Get overall system synchronization quality
     * @param {number} accuracy - Overall accuracy percentage
     * @returns {string} System quality
     * @private
     */
    _getSystemQuality(accuracy) {
        if (accuracy >= 95) return 'excellent';
        if (accuracy >= 85) return 'good';
        if (accuracy >= 70) return 'fair';
        return 'poor';
    }

    /**
     * Generate unique plan ID
     * @returns {string} Plan identifier
     * @private
     */
    _generatePlanId() {
        return `plan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get engine statistics
     * @returns {object} Engine statistics
     */
    getStats() {
        return {
            ...this.syncStats,
            isRunning: this.isRunning,
            activeDevices: this.activeDevices.size,
            syncPlans: this.syncPlans.size,
            bufferQueues: this.bufferQueues.size
        };
    }
}

export { AudioSyncEngine };