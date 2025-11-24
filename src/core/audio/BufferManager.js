import { EventEmitter } from '../utils/EventEmitter.js';
import { TimeUtils } from '../utils/TimeUtils.js';
import { logger } from '../utils/Logger.js';

/**
 * BufferManager manages audio buffers for multiple devices and handles drift correction
 */
class BufferManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Configuration
        this.bufferSize = options.bufferSize || 2048;
        this.sampleRate = options.sampleRate || 44100;
        this.maxBuffers = options.maxBuffers || 10;
        this.bufferAlignmentTolerance = options.bufferAlignmentTolerance || 0.5; // 0.5ms
        
        // Buffer storage
        this.deviceBuffers = new Map(); // deviceId -> { circularBuffer, metadata }
        this.writePositions = new Map(); // deviceId -> current write position
        this.readPositions = new Map(); // deviceId -> current read position
        
        // Drift tracking
        this.bufferDrift = new Map(); // deviceId -> drift measurement
        this.driftHistory = new Map(); // deviceId -> array of drift measurements
        this.correctionHistory = new Map(); // deviceId -> array of corrections applied
        
        // Performance metrics
        this.bufferStats = {
            totalBuffers: 0,
            totalReadOperations: 0,
            totalWriteOperations: 0,
            averageBufferUtilization: 0,
            totalDriftCorrections: 0
        };
        
        this.log = logger.createScopedLogger('BufferManager');
    }

    /**
     * Add a device buffer for management
     * @param {string} deviceId - Device identifier
     * @param {object} options - Device-specific options
     */
    addDeviceBuffer(deviceId, options = {}) {
        if (this.deviceBuffers.has(deviceId)) {
            this.log.warn('Device buffer already exists', { deviceId });
            return;
        }
        
        const bufferSize = options.bufferSize || this.bufferSize;
        const sampleRate = options.sampleRate || this.sampleRate;
        
        // Create circular buffer
        const circularBuffer = new Float32Array(bufferSize);
        
        // Initialize buffer metadata
        const bufferMetadata = {
            size: bufferSize,
            sampleRate,
            createdAt: Date.now(),
            lastWriteTime: null,
            lastReadTime: null,
            writeCount: 0,
            readCount: 0,
            totalSamples: 0
        };
        
        this.deviceBuffers.set(deviceId, {
            buffer: circularBuffer,
            metadata: bufferMetadata
        });
        
        this.writePositions.set(deviceId, 0);
        this.readPositions.set(deviceId, 0);
        this.bufferDrift.set(deviceId, 0);
        this.driftHistory.set(deviceId, []);
        this.correctionHistory.set(deviceId, []);
        
        this.log.info('Device buffer created', {
            deviceId,
            size: bufferSize,
            sampleRate
        });
        
        this.emit('bufferAdded', { deviceId, bufferSize, sampleRate });
    }

    /**
     * Remove a device buffer
     * @param {string} deviceId - Device identifier
     */
    removeDeviceBuffer(deviceId) {
        if (!this.deviceBuffers.has(deviceId)) {
            return;
        }
        
        this.deviceBuffers.delete(deviceId);
        this.writePositions.delete(deviceId);
        this.readPositions.delete(deviceId);
        this.bufferDrift.delete(deviceId);
        this.driftHistory.delete(deviceId);
        this.correctionHistory.delete(deviceId);
        
        this.log.info('Device buffer removed', { deviceId });
        this.emit('bufferRemoved', { deviceId });
    }

    /**
     * Write audio data to device buffer
     * @param {string} deviceId - Device identifier
     * @param {ArrayBuffer} audioData - Audio data
     * @param {number} timestamp - Timestamp for the data
     * @param {object} options - Write options
     */
    writeAudioData(deviceId, audioData, timestamp, options = {}) {
        const bufferEntry = this.deviceBuffers.get(deviceId);
        
        if (!bufferEntry) {
            throw new Error(`Buffer not found for device ${deviceId}`);
        }
        
        const { buffer, metadata } = bufferEntry;
        const writePos = this.writePositions.get(deviceId) || 0;
        
        // Convert ArrayBuffer to Float32Array
        const floatData = new Float32Array(audioData);
        const samplesToWrite = floatData.length;
        
        // Handle buffer wrapping
        const availableSpace = buffer.length - writePos;
        const writeSize = Math.min(samplesToWrite, availableSpace);
        
        // Write data to buffer
        buffer.set(floatData.subarray(0, writeSize), writePos);
        
        // Handle wrapping if necessary
        if (samplesToWrite > writeSize) {
            const remainingSamples = samplesToWrite - writeSize;
            buffer.set(floatData.subarray(writeSize, writeSize + remainingSamples), 0);
        }
        
        // Update positions and metadata
        const newWritePos = (writePos + samplesToWrite) % buffer.length;
        this.writePositions.set(deviceId, newWritePos);
        
        metadata.lastWriteTime = timestamp;
        metadata.writeCount++;
        metadata.totalSamples += samplesToWrite;
        
        // Detect buffer overflow
        if (this._detectBufferOverflow(deviceId)) {
            this.log.warn('Buffer overflow detected', { deviceId });
            this.emit('bufferOverflow', { deviceId });
        }
        
        this.bufferStats.totalWriteOperations++;
        
        this.log.debug('Audio data written to buffer', {
            deviceId,
            samples: samplesToWrite,
            writePosition: newWritePos
        });
        
        this.emit('dataWritten', {
            deviceId,
            samples: samplesToWrite,
            timestamp,
            writePosition: newWritePos
        });
    }

    /**
     * Read synchronized audio data from device buffer
     * @param {string} deviceId - Device identifier
     * @param {number} timestamp - Requested read timestamp
     * @param {number} sampleCount - Number of samples to read
     * @returns {object} Read result
     */
    readSynchronizedData(deviceId, timestamp, sampleCount = 0) {
        const bufferEntry = this.deviceBuffers.get(deviceId);
        
        if (!bufferEntry) {
            throw new Error(`Buffer not found for device ${deviceId}`);
        }
        
        const { buffer, metadata } = bufferEntry;
        const readPos = this.readPositions.get(deviceId) || 0;
        
        // Calculate target read position based on timestamp
        const samplesToSkip = this._calculateSamplesToSkip(deviceId, timestamp);
        const targetReadPos = (readPos + samplesToSkip) % buffer.length;
        
        // Adjust for drift if necessary
        const driftAdjustment = this._getDriftAdjustment(deviceId);
        const adjustedReadPos = (targetReadPos + Math.round(driftAdjustment)) % buffer.length;
        
        // Read data from buffer
        const availableSamples = this._calculateAvailableSamples(deviceId);
        const actualSampleCount = sampleCount > 0 ? Math.min(sampleCount, availableSamples) : availableSamples;
        
        const readData = this._readBufferData(buffer, adjustedReadPos, actualSampleCount);
        
        // Update positions
        this.readPositions.set(deviceId, (adjustedReadPos + actualSampleCount) % buffer.length);
        
        metadata.lastReadTime = timestamp;
        metadata.readCount++;
        
        this.bufferStats.totalReadOperations++;
        
        this.log.debug('Synchronized data read from buffer', {
            deviceId,
            samples: actualSampleCount,
            readPosition: adjustedReadPos,
            driftAdjustment
        });
        
        this.emit('dataRead', {
            deviceId,
            samples: actualSampleCount,
            timestamp,
            readPosition: adjustedReadPos
        });
        
        return {
            data: readData,
            timestamp,
            samples: actualSampleCount,
            readPosition: adjustedReadPos,
            driftAdjustment
        };
    }

    /**
     * Apply drift correction to device buffer
     * @param {string} deviceId - Device identifier
     * @param {number} driftAmount - Drift amount in samples
     * @returns {object} Correction result
     */
    applyDriftCorrection(deviceId, driftAmount) {
        if (!this.deviceBuffers.has(deviceId)) {
            return { success: false, error: 'Buffer not found' };
        }
        
        const currentDrift = this.bufferDrift.get(deviceId) || 0;
        const newDrift = currentDrift + driftAmount;
        
        this.bufferDrift.set(deviceId, newDrift);
        
        // Record correction in history
        const correction = {
            timestamp: Date.now(),
            driftAmount,
            newDrift,
            type: 'buffer_correction'
        };
        
        this.correctionHistory.get(deviceId).push(correction);
        
        // Maintain history size
        const history = this.correctionHistory.get(deviceId);
        if (history.length > 100) {
            history.shift();
        }
        
        this.bufferStats.totalDriftCorrections++;
        
        this.log.debug('Drift correction applied', {
            deviceId,
            driftAmount,
            newDrift
        });
        
        this.emit('driftCorrectionApplied', {
            deviceId,
            driftAmount,
            newDrift,
            correction
        });
        
        return {
            success: true,
            driftAmount,
            newDrift,
            correction
        };
    }

    /**
     * Get buffer status for a device
     * @param {string} deviceId - Device identifier
     * @returns {object} Buffer status
     */
    getBufferStatus(deviceId) {
        const bufferEntry = this.deviceBuffers.get(deviceId);
        
        if (!bufferEntry) {
            return null;
        }
        
        const { buffer, metadata } = bufferEntry;
        const writePos = this.writePositions.get(deviceId) || 0;
        const readPos = this.readPositions.get(deviceId) || 0;
        const currentDrift = this.bufferDrift.get(deviceId) || 0;
        
        const utilization = this._calculateBufferUtilization(deviceId);
        const availableSamples = this._calculateAvailableSamples(deviceId);
        
        return {
            deviceId,
            bufferSize: buffer.length,
            sampleRate: metadata.sampleRate,
            writePosition: writePos,
            readPosition: readPos,
            utilization: Math.round(utilization * 100),
            availableSamples,
            drift: currentDrift,
            lastWriteTime: metadata.lastWriteTime,
            lastReadTime: metadata.lastReadTime,
            writeCount: metadata.writeCount,
            readCount: metadata.readCount,
            totalSamples: metadata.totalSamples
        };
    }

    /**
     * Get all device buffer statuses
     * @returns {object} All buffer statuses
     */
    getAllBufferStatuses() {
        const statuses = {};
        
        for (const deviceId of this.deviceBuffers.keys()) {
            statuses[deviceId] = this.getBufferStatus(deviceId);
        }
        
        return statuses;
    }

    /**
     * Clear device buffer
     * @param {string} deviceId - Device identifier
     */
    clearDeviceBuffer(deviceId) {
        const bufferEntry = this.deviceBuffers.get(deviceId);
        
        if (!bufferEntry) {
            return;
        }
        
        const { buffer } = bufferEntry;
        buffer.fill(0);
        
        // Reset positions
        this.writePositions.set(deviceId, 0);
        this.readPositions.set(deviceId, 0);
        this.bufferDrift.set(deviceId, 0);
        
        // Clear histories
        this.driftHistory.set(deviceId, []);
        this.correctionHistory.set(deviceId, []);
        
        this.log.info('Device buffer cleared', { deviceId });
        this.emit('bufferCleared', { deviceId });
    }

    /**
     * Calculate buffer utilization for a device
     * @param {string} deviceId - Device identifier
     * @returns {number} Utilization percentage (0-1)
     * @private
     */
    _calculateBufferUtilization(deviceId) {
        const writePos = this.writePositions.get(deviceId) || 0;
        const readPos = this.readPositions.get(deviceId) || 0;
        const bufferEntry = this.deviceBuffers.get(deviceId);
        
        if (!bufferEntry) return 0;
        
        const buffer = bufferEntry.buffer;
        
        if (writePos >= readPos) {
            return (writePos - readPos) / buffer.length;
        } else {
            return (buffer.length - readPos + writePos) / buffer.length;
        }
    }

    /**
     * Calculate available samples in buffer
     * @param {string} deviceId - Device identifier
     * @returns {number} Available sample count
     * @private
     */
    _calculateAvailableSamples(deviceId) {
        const writePos = this.writePositions.get(deviceId) || 0;
        const readPos = this.readPositions.get(deviceId) || 0;
        const bufferEntry = this.deviceBuffers.get(deviceId);
        
        if (!bufferEntry) return 0;
        
        const buffer = bufferEntry.buffer;
        
        if (writePos >= readPos) {
            return writePos - readPos;
        } else {
            return buffer.length - readPos + writePos;
        }
    }

    /**
     * Calculate samples to skip based on timestamp
     * @param {string} deviceId - Device identifier
     * @param {number} timestamp - Requested timestamp
     * @returns {number} Samples to skip
     * @private
     */
    _calculateSamplesToSkip(deviceId, timestamp) {
        const bufferEntry = this.deviceBuffers.get(deviceId);
        
        if (!bufferEntry) return 0;
        
        const { metadata } = bufferEntry;
        
        // Calculate time difference
        const timeDiff = timestamp - (metadata.lastWriteTime || timestamp);
        
        // Convert to samples
        const samplesToSkip = TimeUtils.msToSamples(timeDiff, metadata.sampleRate);
        
        return Math.max(0, samplesToSkip);
    }

    /**
     * Get drift adjustment for a device
     * @param {string} deviceId - Device identifier
     * @returns {number} Drift adjustment in samples
     * @private
     */
    _getDriftAdjustment(deviceId) {
        const drift = this.bufferDrift.get(deviceId) || 0;
        
        // Apply smoothing to prevent sudden changes
        const smoothedDrift = 0.1 * drift; // 10% smoothing
        
        return Math.round(smoothedDrift);
    }

    /**
     * Read data from circular buffer
     * @param {Float32Array} buffer - Circular buffer
     * @param {number} startPos - Starting position
     * @param {number} sampleCount - Number of samples to read
     * @returns {Float32Array} Read audio data
     * @private
     */
    _readBufferData(buffer, startPos, sampleCount) {
        const result = new Float32Array(sampleCount);
        const availableSamples = buffer.length - startPos;
        
        // Handle wrapping
        if (sampleCount <= availableSamples) {
            result.set(buffer.subarray(startPos, startPos + sampleCount));
        } else {
            // Read from startPos to end
            result.set(buffer.subarray(startPos));
            
            // Read from beginning
            const remainingSamples = sampleCount - availableSamples;
            result.set(buffer.subarray(0, remainingSamples), availableSamples);
        }
        
        return result;
    }

    /**
     * Detect buffer overflow condition
     * @param {string} deviceId - Device identifier
     * @returns {boolean} True if overflow detected
     * @private
     */
    _detectBufferOverflow(deviceId) {
        const utilization = this._calculateBufferUtilization(deviceId);
        return utilization > 0.95; // 95% utilization threshold
    }

    /**
     * Get buffer statistics
     * @returns {object} Buffer statistics
     */
    getStats() {
        const deviceCount = this.deviceBuffers.size;
        let totalUtilization = 0;
        
        for (const deviceId of this.deviceBuffers.keys()) {
            totalUtilization += this._calculateBufferUtilization(deviceId);
        }
        
        const averageUtilization = deviceCount > 0 ? totalUtilization / deviceCount : 0;
        
        return {
            ...this.bufferStats,
            deviceCount,
            averageUtilization: Math.round(averageUtilization * 100),
            bufferSizes: Array.from(this.deviceBuffers.values()).map(entry => entry.buffer.length)
        };
    }

    /**
     * Reset all buffers and statistics
     */
    reset() {
        for (const deviceId of this.deviceBuffers.keys()) {
            this.clearDeviceBuffer(deviceId);
        }
        
        this.bufferStats = {
            totalBuffers: 0,
            totalReadOperations: 0,
            totalWriteOperations: 0,
            averageBufferUtilization: 0,
            totalDriftCorrections: 0
        };
        
        this.log.info('Buffer manager reset');
        this.emit('reset');
    }
}

export { BufferManager };