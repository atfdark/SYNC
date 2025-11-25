import { EventEmitter } from '../utils/EventEmitter.js';
import { TimeUtils } from '../utils/TimeUtils.js';
import { logger } from '../utils/Logger.js';

/**
 * DriftCorrection handles automatic compensation for clock drift between devices
 * and maintains audio synchronization across all connected devices
 */
class DriftCorrection extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Configuration
        this.driftThreshold = options.driftThreshold || 0.5; // 0.5ms drift threshold
        this.maxCorrection = options.maxCorrection || 2; // 2ms max correction per interval
        this.correctionInterval = options.correctionInterval || 100; // 100ms intervals
        this.adjustmentSmoothing = options.adjustmentSmoothing || 0.1; // 10% smoothing
        
        // Device tracking
        this.deviceClocks = new Map(); // deviceId -> DeviceClock
        this.correctionState = new Map(); // deviceId -> correction state
        
        // Master synchronization state
        this.isActive = false;
        this.lastCorrectionTime = null;
        this.correctionCount = 0;
        
        // Performance monitoring
        this.averageDrift = 0;
        this.driftHistory = [];
        this.maxHistorySize = 100;
        
        this.log = logger.createScopedLogger('DriftCorrection');
    }

    /**
     * Start drift correction monitoring
     */
    start() {
        if (this.isActive) {
            this.log.warn('Drift correction is already active');
            return;
        }
        
        this.isActive = true;
        this.lastCorrectionTime = TimeUtils.getCurrentTime();
        
        this.log.info('Drift correction started', {
            driftThreshold: this.driftThreshold,
            correctionInterval: this.correctionInterval
        });
        
        this.emit('started');
        this._startCorrectionLoop();
    }

    /**
     * Stop drift correction monitoring
     */
    stop() {
        if (!this.isActive) {
            return;
        }
        
        this.isActive = false;
        
        this.log.info('Drift correction stopped', {
            totalCorrections: this.correctionCount
        });
        
        this.emit('stopped');
    }

    /**
     * Add a device for drift correction monitoring
     * @param {string} deviceId - Device identifier
     * @param {object} deviceClock - Device clock instance
     */
    addDevice(deviceId, deviceClock) {
        this.deviceClocks.set(deviceId, deviceClock);
        this.correctionState.set(deviceId, {
            pendingAdjustment: 0,
            lastAdjustment: 0,
            correctionCount: 0,
            quality: 'unknown'
        });
        
        this.log.debug('Device added for drift correction', { deviceId });
    }

    /**
     * Remove a device from drift correction monitoring
     * @param {string} deviceId - Device identifier
     */
    removeDevice(deviceId) {
        this.deviceClocks.delete(deviceId);
        this.correctionState.delete(deviceId);
        
        this.log.debug('Device removed from drift correction', { deviceId });
        this.emit('deviceRemoved', { deviceId });
    }

    /**
     * Perform drift correction for all devices
     * @param {number} masterTime - Current master clock time
     * @returns {object} Correction results
     */
    performCorrection(masterTime) {
        if (!this.isActive) {
            return { success: false, error: 'Drift correction not active' };
        }
        
        const corrections = [];
        let totalAdjustment = 0;
        let deviceCount = 0;
        
        for (const [deviceId, deviceClock] of this.deviceClocks) {
            const correction = this._correctDeviceDrift(deviceId, deviceClock, masterTime);
            
            if (correction.applied) {
                corrections.push(correction);
                totalAdjustment += Math.abs(correction.adjustment);
                deviceCount++;
            }
        }
        
        // Update statistics
        this._updateCorrectionStatistics(corrections, masterTime);
        
        const result = {
            success: true,
            timestamp: masterTime,
            corrections,
            summary: {
                totalDevices: this.deviceClocks.size,
                correctedDevices: deviceCount,
                totalAdjustment,
                averageAdjustment: deviceCount > 0 ? totalAdjustment / deviceCount : 0
            }
        };
        
        if (corrections.length > 0) {
            this.log.debug('Drift correction performed', {
                correctedDevices: deviceCount,
                averageAdjustment: result.summary.averageAdjustment
            });
            
            this.emit('correctionsApplied', result);
        }
        
        this.correctionCount++;
        this.lastCorrectionTime = masterTime;
        
        return result;
    }

    /**
     * Get drift correction statistics
     * @returns {object} Statistics object
     */
    getStats() {
        return {
            isActive: this.isActive,
            deviceCount: this.deviceClocks.size,
            correctionCount: this.correctionCount,
            lastCorrectionTime: this.lastCorrectionTime,
            averageDrift: this.averageDrift,
            driftHistory: [...this.driftHistory],
            configuration: {
                driftThreshold: this.driftThreshold,
                correctionInterval: this.correctionInterval,
                maxCorrection: this.maxCorrection
            }
        };
    }

    /**
     * Get device-specific correction state
     * @param {string} deviceId - Device identifier
     * @returns {object} Device correction state
     */
    getDeviceCorrectionState(deviceId) {
        const deviceClock = this.deviceClocks.get(deviceId);
        const correctionState = this.correctionState.get(deviceId);
        
        if (!deviceClock || !correctionState) {
            return null;
        }
        
        return {
            deviceId,
            deviceStats: deviceClock.getStats(),
            correctionState,
            qualityMetrics: deviceClock.getQualityMetrics()
        };
    }

    /**
     * Set drift correction configuration
     * @param {object} config - Configuration object
     */
    setConfiguration(config) {
        if (config.driftThreshold !== undefined) {
            this.driftThreshold = config.driftThreshold;
        }
        
        if (config.maxCorrection !== undefined) {
            this.maxCorrection = config.maxCorrection;
        }
        
        if (config.correctionInterval !== undefined) {
            this.correctionInterval = config.correctionInterval;
        }
        
        if (config.adjustmentSmoothing !== undefined) {
            this.adjustmentSmoothing = config.adjustmentSmoothing;
        }
        
        this.log.info('Drift correction configuration updated', config);
        this.emit('configurationChanged', config);
    }

    /**
     * Force a synchronization correction for a specific device
     * @param {string} deviceId - Device identifier
     * @param {number} masterTime - Current master clock time
     * @returns {object} Correction result
     */
    forceDeviceCorrection(deviceId, masterTime) {
        const deviceClock = this.deviceClocks.get(deviceId);
        
        if (!deviceClock) {
            return { success: false, error: 'Device not found' };
        }
        
        this.log.info('Forcing device correction', { deviceId });
        
        return this._correctDeviceDrift(deviceId, deviceClock, masterTime, true);
    }

    /**
     * Correct drift for a specific device
     * @param {string} deviceId - Device identifier
     * @param {object} deviceClock - Device clock instance
     * @param {number} masterTime - Current master clock time
     * @param {boolean} force - Force correction regardless of threshold
     * @returns {object} Correction result
     * @private
     */
    _correctDeviceDrift(deviceId, deviceClock, masterTime, force = false) {
        const deviceTime = deviceClock.getSynchronizedTime(masterTime);
        const expectedTime = masterTime; // In a perfectly synchronized system
        const drift = deviceTime - expectedTime;
        
        const state = this.correctionState.get(deviceId);
        
        // Check if correction is needed
        const needsCorrection = force || Math.abs(drift) > this.driftThreshold;
        
        if (!needsCorrection) {
            return {
                deviceId,
                applied: false,
                reason: 'Within tolerance',
                drift,
                quality: deviceClock.getQualityMetrics().quality
            };
        }
        
        // Calculate required adjustment
        const rawAdjustment = -drift; // Negative because we want to reduce the drift
        const clampedAdjustment = Math.max(-this.maxCorrection, 
                                         Math.min(this.maxCorrection, rawAdjustment));
        
        // Apply smoothing to prevent sudden changes
        const smoothedAdjustment = this.adjustmentSmoothing * clampedAdjustment + 
                                 (1 - this.adjustmentSmoothing) * state.pendingAdjustment;
        
        // Update correction state
        state.pendingAdjustment = smoothedAdjustment;
        state.lastAdjustment = smoothedAdjustment;
        state.correctionCount++;
        state.quality = deviceClock.getQualityMetrics().quality;
        
        // Emit correction event for the device
        const correction = {
            deviceId,
            applied: true,
            drift,
            adjustment: smoothedAdjustment,
            timestamp: masterTime,
            quality: state.quality
        };
        
        this.emit('deviceCorrectionApplied', correction);
        
        return correction;
    }

    /**
     * Start the correction monitoring loop
     * @private
     */
    _startCorrectionLoop() {
        if (!this.isActive) {
            return;
        }
        
        const correctionLoop = () => {
            if (!this.isActive) {
                return;
            }
            
            const currentTime = TimeUtils.getCurrentTime();
            
            if (!this.lastCorrectionTime || 
                (currentTime - this.lastCorrectionTime) >= this.correctionInterval) {
                this.performCorrection(currentTime);
            }
            
            // Schedule next iteration
            setTimeout(() => {
                requestAnimationFrame(correctionLoop);
            }, this.correctionInterval);
        };
        
        requestAnimationFrame(correctionLoop);
        
        this.log.debug('Correction monitoring loop started');
    }

    /**
     * Update correction statistics
     * @param {Array} corrections - Array of corrections performed
     * @param {number} timestamp - Correction timestamp
     * @private
     */
    _updateCorrectionStatistics(corrections, timestamp) {
        if (corrections.length === 0) {
            return;
        }
        
        // Calculate average drift from corrections
        const totalDrift = corrections.reduce((sum, c) => sum + Math.abs(c.drift), 0);
        const averageDrift = totalDrift / corrections.length;
        
        // Update running average
        const smoothingFactor = 0.1;
        this.averageDrift = smoothingFactor * averageDrift + 
                           (1 - smoothingFactor) * this.averageDrift;
        
        // Add to history
        this.driftHistory.push({
            timestamp,
            averageDrift,
            deviceCount: corrections.length,
            totalAdjustment: corrections.reduce((sum, c) => sum + Math.abs(c.adjustment), 0)
        });
        
        // Maintain history size
        if (this.driftHistory.length > this.maxHistorySize) {
            this.driftHistory.shift();
        }
    }

    /**
     * Get overall system synchronization quality
     * @returns {object} Quality assessment
     */
    getSystemQuality() {
        if (this.deviceClocks.size === 0) {
            return {
                overall: 'unknown',
                message: 'No devices connected',
                deviceCount: 0
            };
        }
        
        let totalQuality = 0;
        let deviceCount = 0;
        const deviceQualities = [];
        
        for (const [deviceId, deviceClock] of this.deviceClocks) {
            const metrics = deviceClock.getQualityMetrics();
            totalQuality += this._convertQualityToScore(metrics.quality);
            deviceQualities.push({
                deviceId,
                quality: metrics.quality,
                accuracy: metrics.syncAccuracy
            });
            deviceCount++;
        }
        
        const averageScore = totalQuality / deviceCount;
        let overallQuality;
        
        if (averageScore >= 0.9) {
            overallQuality = 'excellent';
        } else if (averageScore >= 0.7) {
            overallQuality = 'good';
        } else if (averageScore >= 0.5) {
            overallQuality = 'fair';
        } else {
            overallQuality = 'poor';
        }
        
        return {
            overall: overallQuality,
            averageScore,
            deviceCount,
            deviceQualities,
            averageDrift: this.averageDrift,
            totalCorrections: this.correctionCount
        };
    }

    /**
     * Convert quality string to numeric score
     * @param {string} quality - Quality string
     * @returns {number} Quality score (0-1)
     * @private
     */
    _convertQualityToScore(quality) {
        switch (quality) {
            case 'excellent': return 1.0;
            case 'good': return 0.8;
            case 'fair': return 0.6;
            case 'poor': return 0.3;
            default: return 0.5;
        }
    }
}

export { DriftCorrection };