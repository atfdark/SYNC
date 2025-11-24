import { EventEmitter } from '../utils/EventEmitter.js';
import { TimeUtils } from '../utils/TimeUtils.js';
import { logger } from '../utils/Logger.js';

/**
 * DeviceClock manages timing for individual Bluetooth devices
 * and handles clock synchronization with the master clock
 */
class DeviceClock extends EventEmitter {
    constructor(deviceId, options = {}) {
        super();
        
        this.deviceId = deviceId;
        
        // Clock state
        this.offset = 0; // Offset from master clock in milliseconds
        this.driftRate = 0; // Drift rate in ppm (parts per million)
        this.lastSyncTime = null;
        this.syncCount = 0;
        
        // Configuration
        this.syncTolerance = options.syncTolerance || 1; // 1ms
        this.maxOffset = options.maxOffset || 10; // 10ms
        this.syncInterval = options.syncInterval || 1000; // 1 second
        this.measurementTimeout = options.measurementTimeout || 100; // 100ms
        
        // Performance tracking
        this.latency = 0;
        this.jitter = 0;
        this.recentLatencies = [];
        this.maxLatencySamples = 10;
        
        this.log = logger.createScopedLogger(`DeviceClock:${deviceId}`);
    }

    /**
     * Get the current synchronized time for this device
     * @param {number} masterTime - Master clock time
     * @returns {number} Synchronized device time
     */
    getSynchronizedTime(masterTime) {
        const baseTime = masterTime + this.offset;
        const driftAdjustment = this._calculateDriftAdjustment(masterTime);
        
        return baseTime + driftAdjustment;
    }

    /**
     * Update clock offset based on sync measurement
     * @param {number} masterTime - Master clock time
     * @param {number} deviceTime - Device time
     * @param {number} roundTripTime - Round trip measurement time
     * @returns {object} Sync result
     */
    updateOffset(masterTime, deviceTime, roundTripTime) {
        const timer = TimeUtils.createTimer();
        timer.start();
        
        try {
            // Calculate one-way latency
            const oneWayLatency = roundTripTime / 2;
            
            // Calculate offset assuming device time represents the time
            // when the message was received/processed
            const syncOffset = deviceTime - masterTime - oneWayLatency;
            
            // Update recent latency measurements
            this._updateLatencyMeasurement(oneWayLatency);
            
            // Calculate new offset with smoothing
            const smoothingFactor = 0.1;
            const previousOffset = this.offset;
            this.offset = smoothingFactor * syncOffset + (1 - smoothingFactor) * this.offset;
            
            // Update drift rate
            this._updateDriftRate(masterTime, this.offset, previousOffset);
            
            // Update sync tracking
            this.lastSyncTime = masterTime;
            this.syncCount++;
            
            const result = {
                success: true,
                offset: this.offset,
                driftRate: this.driftRate,
                latency: this.latency,
                jitter: this.jitter,
                syncAccuracy: this._calculateSyncAccuracy(this.offset),
                measurementTime: timer.stop()
            };
            
            this.log.debug('Clock offset updated', {
                oldOffset: previousOffset,
                newOffset: this.offset,
                syncAccuracy: result.syncAccuracy
            });
            
            this.emit('offsetUpdated', result);
            
            return result;
            
        } catch (error) {
            const result = {
                success: false,
                error: error.message,
                measurementTime: timer.stop()
            };
            
            this.log.error('Failed to update clock offset', { error });
            this.emit('syncError', result);
            
            return result;
        }
    }

    /**
     * Perform a clock synchronization measurement
     * @param {number} masterTime - Master clock time
     * @param {Function} sendPing - Function to send ping to device
     * @returns {Promise<object>} Sync measurement result
     */
    async performSyncMeasurement(masterTime, sendPing) {
        const timer = TimeUtils.createTimer();
        timer.start();
        
        try {
            // Send ping and measure round trip time
            const pingStartTime = performance.now();
            const deviceResponseTime = await sendPing(this.deviceId);
            const roundTripTime = performance.now() - pingStartTime;
            
            // Check if measurement is valid
            if (roundTripTime > this.measurementTimeout) {
                throw new Error(`Sync measurement timeout: ${roundTripTime}ms`);
            }
            
            // Update offset
            const result = this.updateOffset(masterTime, deviceResponseTime, roundTripTime);
            result.measurementTime = timer.stop();
            
            return result;
            
        } catch (error) {
            const result = {
                success: false,
                error: error.message,
                measurementTime: timer.stop()
            };
            
            this.log.error('Sync measurement failed', { error });
            return result;
        }
    }

    /**
     * Check if device clock is synchronized within tolerance
     * @param {number} masterTime - Master clock time
     * @returns {boolean} True if synchronized
     */
    isSynchronized(masterTime) {
        const deviceTime = this.getSynchronizedTime(masterTime);
        const offsetMagnitude = Math.abs(this.offset);
        
        return offsetMagnitude <= this.syncTolerance;
    }

    /**
     * Get device clock statistics
     * @returns {object} Clock statistics
     */
    getStats() {
        return {
            deviceId: this.deviceId,
            offset: this.offset,
            driftRate: this.driftRate,
            latency: this.latency,
            jitter: this.jitter,
            lastSyncTime: this.lastSyncTime,
            syncCount: this.syncCount,
            syncTolerance: this.syncTolerance,
            isSynchronized: this.lastSyncTime ? 
                this.isSynchronized(this.lastSyncTime) : false,
            recentLatencies: [...this.recentLatencies]
        };
    }

    /**
     * Set sync configuration
     * @param {object} config - Configuration object
     */
    setConfig(config) {
        if (config.syncTolerance !== undefined) {
            this.syncTolerance = config.syncTolerance;
        }
        
        if (config.maxOffset !== undefined) {
            this.maxOffset = config.maxOffset;
        }
        
        if (config.syncInterval !== undefined) {
            this.syncInterval = config.syncInterval;
        }
        
        if (config.measurementTimeout !== undefined) {
            this.measurementTimeout = config.measurementTimeout;
        }
        
        this.log.debug('Device clock config updated', config);
    }

    /**
     * Reset device clock to initial state
     */
    reset() {
        this.offset = 0;
        this.driftRate = 0;
        this.lastSyncTime = null;
        this.syncCount = 0;
        this.latency = 0;
        this.jitter = 0;
        this.recentLatencies = [];
        
        this.log.info('Device clock reset');
        this.emit('reset');
    }

    /**
     * Get clock quality metrics
     * @returns {object} Quality metrics
     */
    getQualityMetrics() {
        const offsetMagnitude = Math.abs(this.offset);
        const latencyStability = this._calculateLatencyStability();
        
        let quality = 'good';
        
        if (offsetMagnitude > this.syncTolerance * 2 || this.latency > 50) {
            quality = 'poor';
        } else if (offsetMagnitude > this.syncTolerance || this.latency > 20) {
            quality = 'fair';
        }
        
        return {
            quality,
            offsetMagnitude,
            latencyStability,
            syncAccuracy: this._calculateSyncAccuracy(this.offset),
            recommendation: this._getQualityRecommendation(quality)
        };
    }

    /**
     * Calculate drift adjustment for current time
     * @param {number} currentTime - Current master time
     * @returns {number} Drift adjustment in milliseconds
     * @private
     */
    _calculateDriftAdjustment(currentTime) {
        if (!this.lastSyncTime) {
            return 0;
        }
        
        const timeSinceSync = currentTime - this.lastSyncTime;
        
        // Calculate drift over time
        // Drift rate is in ppm (parts per million)
        const driftInMs = (this.driftRate * timeSinceSync) / 1000000;
        
        return driftInMs;
    }

    /**
     * Update drift rate calculation
     * @param {number} masterTime - Master clock time
     * @param {number} currentOffset - Current offset
     * @param {number} previousOffset - Previous offset
     * @private
     */
    _updateDriftRate(masterTime, currentOffset, previousOffset) {
        if (!this.lastSyncTime) {
            return;
        }
        
        const timeDelta = masterTime - this.lastSyncTime;
        const offsetDelta = currentOffset - previousOffset;
        
        // Calculate drift rate in ppm
        if (timeDelta > 0) {
            const driftRatePpm = (offsetDelta * 1000000) / timeDelta;
            
            // Smooth the drift rate
            const smoothingFactor = 0.1;
            this.driftRate = smoothingFactor * driftRatePpm + (1 - smoothingFactor) * this.driftRate;
        }
    }

    /**
     * Update latency measurement
     * @param {number} latency - Measured latency
     * @private
     */
    _updateLatencyMeasurement(latency) {
        // Add to recent measurements
        this.recentLatencies.push(latency);
        
        // Maintain buffer size
        if (this.recentLatencies.length > this.maxLatencySamples) {
            this.recentLatencies.shift();
        }
        
        // Calculate average latency
        const sum = this.recentLatencies.reduce((a, b) => a + b, 0);
        this.latency = sum / this.recentLatencies.length;
        
        // Calculate jitter (standard deviation)
        const variance = this.recentLatencies.reduce((acc, val) => {
            return acc + Math.pow(val - this.latency, 2);
        }, 0) / this.recentLatencies.length;
        
        this.jitter = Math.sqrt(variance);
    }

    /**
     * Calculate sync accuracy percentage
     * @param {number} offset - Current offset
     * @returns {number} Accuracy percentage
     * @private
     */
    _calculateSyncAccuracy(offset) {
        const maxAcceptableOffset = this.syncTolerance;
        const accuracy = Math.max(0, 1 - (Math.abs(offset) / maxAcceptableOffset));
        return Math.round(accuracy * 100);
    }

    /**
     * Calculate latency stability
     * @returns {number} Stability score (0-1)
     * @private
     */
    _calculateLatencyStability() {
        if (this.recentLatencies.length < 2) {
            return 1;
        }
        
        const variations = [];
        for (let i = 1; i < this.recentLatencies.length; i++) {
            variations.push(Math.abs(this.recentLatencies[i] - this.recentLatencies[i - 1]));
        }
        
        const avgVariation = variations.reduce((a, b) => a + b, 0) / variations.length;
        
        // Normalize to 0-1 scale (lower variation = higher stability)
        return Math.max(0, 1 - (avgVariation / 10)); // 10ms max variation
    }

    /**
     * Get quality recommendation
     * @param {string} quality - Quality level
     * @returns {string} Recommendation
     * @private
     */
    _getQualityRecommendation(quality) {
        switch (quality) {
            case 'poor':
                return 'Device requires immediate reconnection or is out of range';
            case 'fair':
                return 'Consider checking device connection and reducing audio buffer size';
            case 'good':
                return 'Device synchronization is optimal';
            default:
                return 'Unknown quality status';
        }
    }
}

export { DeviceClock };