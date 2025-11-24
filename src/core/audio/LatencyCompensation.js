import { EventEmitter } from '../utils/EventEmitter.js';
import { TimeUtils } from '../utils/TimeUtils.js';
import { logger } from '../utils/Logger.js';

/**
 * LatencyCompensation measures and compensates for network latency between devices
 */
class LatencyCompensation extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Configuration
        this.measurementInterval = options.measurementInterval || 5000; // 5 seconds
        this.timeout = options.timeout || 1000; // 1 second timeout
        this.sampleSize = options.sampleSize || 10; // Number of measurements to average
        this.maxLatency = options.maxLatency || 100; // 100ms maximum reasonable latency
        
        // Latency storage
        this.deviceLatencies = new Map(); // deviceId -> latency data
        this.latencyHistory = new Map(); // deviceId -> array of measurements
        this.measurementStates = new Map(); // deviceId -> measurement state
        
        // Performance tracking
        this.latencyStats = {
            totalMeasurements: 0,
            successfulMeasurements: 0,
            failedMeasurements: 0,
            averageLatency: 0,
            lastMeasurementTime: null
        };
        
        // Quality assessment
        this.qualityThresholds = {
            excellent: 10,  // < 10ms
            good: 25,       // < 25ms  
            fair: 50,       // < 50ms
            poor: 100       // < 100ms
        };
        
        this.log = logger.createScopedLogger('LatencyCompensation');
    }

    /**
     * Measure latency for a specific device
     * @param {string} deviceId - Device identifier
     * @param {Function} sendPingFunction - Function to send ping to device
     * @returns {Promise<object>} Latency measurement result
     */
    async measureLatency(deviceId, sendPingFunction) {
        const measurementId = this._generateMeasurementId();
        
        this.log.debug('Starting latency measurement', { deviceId, measurementId });
        
        try {
            // Set up measurement state
            this.measurementStates.set(deviceId, {
                id: measurementId,
                startTime: performance.now(),
                attempts: 0,
                measurements: []
            });
            
            // Perform multiple measurements for accuracy
            const measurements = await this._performLatencyMeasurement(deviceId, sendPingFunction);
            
            // Calculate statistics
            const result = this._calculateLatencyStatistics(deviceId, measurements);
            
            // Store result
            this._storeLatencyResult(deviceId, result);
            
            // Update statistics
            this._updateLatencyStats(true);
            
            this.log.info('Latency measurement completed', {
                deviceId,
                latency: result.latency,
                quality: result.quality,
                samples: measurements.length
            });
            
            this.emit('latencyMeasured', { deviceId, result });
            
            return result;
            
        } catch (error) {
            this._updateLatencyStats(false);
            
            this.log.error('Latency measurement failed', {
                deviceId,
                error: error.message
            });
            
            this.emit('latencyMeasurementFailed', { deviceId, error });
            
            throw error;
            
        } finally {
            this.measurementStates.delete(deviceId);
        }
    }

    /**
     * Start continuous latency monitoring for a device
     * @param {string} deviceId - Device identifier
     * @param {Function} sendPingFunction - Function to send ping to device
     * @returns {Promise<void>}
     */
    async startLatencyMonitoring(deviceId, sendPingFunction) {
        this.log.info('Starting latency monitoring', { deviceId });
        
        const monitoringLoop = async () => {
            if (!this.measurementStates.has(deviceId)) {
                return; // Monitoring stopped
            }
            
            try {
                await this.measureLatency(deviceId, sendPingFunction);
                
                // Wait for next measurement interval
                setTimeout(monitoringLoop, this.measurementInterval);
                
            } catch (error) {
                this.log.warn('Latency measurement failed in monitoring', {
                    deviceId,
                    error: error.message
                });
                
                // Retry after shorter interval on failure
                setTimeout(monitoringLoop, this.measurementInterval / 2);
            }
        };
        
        // Start monitoring
        monitoringLoop();
        
        this.emit('latencyMonitoringStarted', { deviceId });
    }

    /**
     * Stop latency monitoring for a device
     * @param {string} deviceId - Device identifier
     */
    stopLatencyMonitoring(deviceId) {
        this.measurementStates.delete(deviceId);
        
        this.log.info('Latency monitoring stopped', { deviceId });
        this.emit('latencyMonitoringStopped', { deviceId });
    }

    /**
     * Get current latency for a device
     * @param {string} deviceId - Device identifier
     * @returns {object|null} Latency data or null if not measured
     */
    getDeviceLatency(deviceId) {
        return this.deviceLatencies.get(deviceId) || null;
    }

    /**
     * Get all device latencies
     * @returns {object} All device latencies
     */
    getAllLatencies() {
        const latencies = {};
        
        for (const [deviceId, data] of this.deviceLatencies) {
            latencies[deviceId] = data;
        }
        
        return latencies;
    }

    /**
     * Apply latency compensation to timestamp
     * @param {string} deviceId - Device identifier
     * @param {number} timestamp - Original timestamp
     * @returns {number} Compensated timestamp
     */
    compensateForLatency(deviceId, timestamp) {
        const latencyData = this.deviceLatencies.get(deviceId);
        
        if (!latencyData) {
            this.log.warn('No latency data for device, using uncompensated timestamp', { deviceId });
            return timestamp;
        }
        
        const compensation = latencyData.oneWayLatency;
        const compensatedTimestamp = timestamp + compensation;
        
        this.log.debug('Latency compensation applied', {
            deviceId,
            original: timestamp,
            compensated: compensatedTimestamp,
            compensation
        });
        
        return compensatedTimestamp;
    }

    /**
     * Get latency quality for a device
     * @param {string} deviceId - Device identifier
     * @returns {string} Quality assessment
     */
    getLatencyQuality(deviceId) {
        const latencyData = this.deviceLatencies.get(deviceId);
        
        if (!latencyData) {
            return 'unknown';
        }
        
        const latency = latencyData.oneWayLatency;
        
        if (latency <= this.qualityThresholds.excellent) {
            return 'excellent';
        } else if (latency <= this.qualityThresholds.good) {
            return 'good';
        } else if (latency <= this.qualityThresholds.fair) {
            return 'fair';
        } else if (latency <= this.qualityThresholds.poor) {
            return 'poor';
        } else {
            return 'critical';
        }
    }

    /**
     * Get overall latency statistics
     * @returns {object} Latency statistics
     */
    getLatencyStats() {
        const deviceCount = this.deviceLatencies.size;
        let totalLatency = 0;
        let qualityCounts = {
            excellent: 0,
            good: 0,
            fair: 0,
            poor: 0,
            critical: 0,
            unknown: 0
        };
        
        for (const [deviceId] of this.deviceLatencies) {
            const quality = this.getLatencyQuality(deviceId);
            qualityCounts[quality]++;
            
            const latencyData = this.deviceLatencies.get(deviceId);
            if (latencyData) {
                totalLatency += latencyData.oneWayLatency;
            }
        }
        
        const averageLatency = deviceCount > 0 ? totalLatency / deviceCount : 0;
        
        return {
            ...this.latencyStats,
            deviceCount,
            averageLatency: Math.round(averageLatency),
            qualityDistribution: qualityCounts
        };
    }

    /**
     * Calibrate latency measurements for better accuracy
     * @param {string} deviceId - Device identifier
     * @param {Array} calibrationData - Array of measurement results
     */
    calibrateLatencyMeasurements(deviceId, calibrationData) {
        if (!calibrationData || calibrationData.length === 0) {
            return;
        }
        
        // Apply statistical calibration
        const roundTripTimes = calibrationData.map(m => m.roundTripTime);
        const oneWayLatencies = calibrationData.map(m => m.oneWayLatency);
        
        // Calculate baseline statistics
        const baselineRTT = this._calculateMedian(roundTripTimes);
        const baselineOneWay = this._calculateMedian(oneWayLatencies);
        
        // Create calibration factor
        const calibrationFactor = baselineOneWay / (baselineRTT / 2);
        
        // Update existing measurements with calibration
        const latencyData = this.deviceLatencies.get(deviceId);
        if (latencyData) {
            latencyData.calibrationFactor = calibrationFactor;
            latencyData.calibrated = true;
            
            this.log.info('Latency measurements calibrated', {
                deviceId,
                calibrationFactor,
                baselineOneWay,
                baselineRTT
            });
        }
        
        this.emit('latencyCalibrated', {
            deviceId,
            calibrationFactor,
            baselineRTT,
            baselineOneWay
        });
    }

    /**
     * Reset latency data for a device
     * @param {string} deviceId - Device identifier
     */
    resetLatencyData(deviceId) {
        this.deviceLatencies.delete(deviceId);
        this.latencyHistory.delete(deviceId);
        this.measurementStates.delete(deviceId);
        
        this.log.info('Latency data reset', { deviceId });
        this.emit('latencyDataReset', { deviceId });
    }

    /**
     * Perform latency measurement sequence
     * @param {string} deviceId - Device identifier
     * @param {Function} sendPingFunction - Function to send ping
     * @returns {Promise<Array>} Array of measurement results
     * @private
     */
    async _performLatencyMeasurement(deviceId, sendPingFunction) {
        const measurements = [];
        const measurementState = this.measurementStates.get(deviceId);
        
        // Perform multiple measurements
        for (let i = 0; i < this.sampleSize; i++) {
            try {
                measurementState.attempts++;
                
                const measurement = await this._singleLatencyMeasurement(deviceId, sendPingFunction);
                measurements.push(measurement);
                
                // Add small delay between measurements
                if (i < this.sampleSize - 1) {
                    await TimeUtils.wait(100);
                }
                
            } catch (error) {
                this.log.warn(`Latency measurement attempt ${i + 1} failed`, {
                    deviceId,
                    error: error.message
                });
            }
        }
        
        return measurements;
    }

    /**
     * Perform a single latency measurement
     * @param {string} deviceId - Device identifier
     * @param {Function} sendPingFunction - Function to send ping
     * @returns {Promise<object>} Single measurement result
     * @private
     */
    async _singleLatencyMeasurement(deviceId, sendPingFunction) {
        const startTime = performance.now();
        
        try {
            // Send ping and wait for response
            const responseTime = await sendPingFunction(deviceId, this.timeout);
            const endTime = performance.now();
            
            const roundTripTime = endTime - startTime;
            
            // Validate measurement
            if (roundTripTime > this.timeout) {
                throw new Error(`Measurement timeout: ${roundTripTime}ms`);
            }
            
            if (roundTripTime <= 0) {
                throw new Error(`Invalid round trip time: ${roundTripTime}ms`);
            }
            
            // Calculate one-way latency (assuming symmetric path)
            const oneWayLatency = roundTripTime / 2;
            
            // Validate one-way latency
            if (oneWayLatency > this.maxLatency) {
                throw new Error(`Latency too high: ${oneWayLatency}ms`);
            }
            
            return {
                roundTripTime,
                oneWayLatency,
                timestamp: Date.now(),
                success: true
            };
            
        } catch (error) {
            return {
                roundTripTime: 0,
                oneWayLatency: 0,
                timestamp: Date.now(),
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Calculate latency statistics from measurements
     * @param {string} deviceId - Device identifier
     * @param {Array} measurements - Array of measurements
     * @returns {object} Calculated statistics
     * @private
     */
    _calculateLatencyStatistics(deviceId, measurements) {
        const successfulMeasurements = measurements.filter(m => m.success);
        
        if (successfulMeasurements.length === 0) {
            throw new Error('No successful latency measurements');
        }
        
        const roundTripTimes = successfulMeasurements.map(m => m.roundTripTime);
        const oneWayLatencies = successfulMeasurements.map(m => m.oneWayLatency);
        
        // Calculate statistics
        const avgRoundTrip = this._calculateMean(roundTripTimes);
        const avgOneWay = this._calculateMean(oneWayLatencies);
        const medianRoundTrip = this._calculateMedian(roundTripTimes);
        const medianOneWay = this._calculateMedian(oneWayLatencies);
        const stdDev = this._calculateStandardDeviation(oneWayLatencies);
        const jitter = this._calculateJitter(oneWayLatencies);
        
        // Determine quality
        const quality = this._assessLatencyQuality(avgOneWay);
        
        return {
            deviceId,
            latency: avgOneWay,
            roundTripTime: avgRoundTrip,
            medianLatency: medianOneWay,
            medianRoundTrip: medianRoundTrip,
            standardDeviation: stdDev,
            jitter,
            quality,
            sampleCount: successfulMeasurements.length,
            totalAttempts: measurements.length,
            timestamp: Date.now()
        };
    }

    /**
     * Store latency measurement result
     * @param {string} deviceId - Device identifier
     * @param {object} result - Latency measurement result
     * @private
     */
    _storeLatencyResult(deviceId, result) {
        // Store current latency
        this.deviceLatencies.set(deviceId, result);
        
        // Store in history
        if (!this.latencyHistory.has(deviceId)) {
            this.latencyHistory.set(deviceId, []);
        }
        
        const history = this.latencyHistory.get(deviceId);
        history.push(result);
        
        // Maintain history size
        if (history.length > 100) {
            history.shift();
        }
    }

    /**
     * Update latency measurement statistics
     * @param {boolean} success - Whether measurement was successful
     * @private
     */
    _updateLatencyStats(success) {
        this.latencyStats.totalMeasurements++;
        
        if (success) {
            this.latencyStats.successfulMeasurements++;
        } else {
            this.latencyStats.failedMeasurements++;
        }
        
        this.latencyStats.lastMeasurementTime = Date.now();
        
        // Calculate running average
        const alpha = 0.1;
        const currentAvg = this.latencyStats.averageLatency;
        const newAvg = currentAvg === 0 ? 
            this._getCurrentAverageLatency() :
            alpha * this._getCurrentAverageLatency() + (1 - alpha) * currentAvg;
        
        this.latencyStats.averageLatency = newAvg;
    }

    /**
     * Get current average latency across all devices
     * @returns {number} Current average latency
     * @private
     */
    _getCurrentAverageLatency() {
        const latencies = Array.from(this.deviceLatencies.values())
            .map(data => data.latency);
        
        return latencies.length > 0 ? 
            latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length : 0;
    }

    /**
     * Assess latency quality based on thresholds
     * @param {number} latency - Latency value in milliseconds
     * @returns {string} Quality assessment
     * @private
     */
    _assessLatencyQuality(latency) {
        if (latency <= this.qualityThresholds.excellent) {
            return 'excellent';
        } else if (latency <= this.qualityThresholds.good) {
            return 'good';
        } else if (latency <= this.qualityThresholds.fair) {
            return 'fair';
        } else if (latency <= this.qualityThresholds.poor) {
            return 'poor';
        } else {
            return 'critical';
        }
    }

    /**
     * Calculate mean of array
     * @param {Array} values - Array of numbers
     * @returns {number} Mean value
     * @private
     */
    _calculateMean(values) {
        return values.reduce((sum, val) => sum + val, 0) / values.length;
    }

    /**
     * Calculate median of array
     * @param {Array} values - Array of numbers
     * @returns {number} Median value
     * @private
     */
    _calculateMedian(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        
        return sorted.length % 2 !== 0 ? 
            sorted[mid] : 
            (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Calculate standard deviation
     * @param {Array} values - Array of numbers
     * @returns {number} Standard deviation
     * @private
     */
    _calculateStandardDeviation(values) {
        const mean = this._calculateMean(values);
        const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
        const avgSquaredDiff = this._calculateMean(squaredDiffs);
        return Math.sqrt(avgSquaredDiff);
    }

    /**
     * Calculate jitter (variation in latency)
     * @param {Array} values - Array of latency values
     * @returns {number} Jitter value
     * @private
     */
    _calculateJitter(values) {
        if (values.length < 2) return 0;
        
        const differences = [];
        for (let i = 1; i < values.length; i++) {
            differences.push(Math.abs(values[i] - values[i - 1]));
        }
        
        return this._calculateMean(differences);
    }

    /**
     * Generate unique measurement ID
     * @returns {string} Measurement identifier
     * @private
     */
    _generateMeasurementId() {
        return `lat_meas_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get statistics object
     * @returns {object} Latency compensation statistics
     */
    getStats() {
        return this.getLatencyStats();
    }
}

export { LatencyCompensation };