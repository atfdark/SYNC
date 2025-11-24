/**
 * Time utility functions for Web Bluetooth Audio Sync
 */
class TimeUtils {
    /**
     * Get current high-resolution timestamp
     * @returns {number} High-resolution timestamp in milliseconds
     */
    static getCurrentTime() {
        return performance.now();
    }

    /**
     * Convert milliseconds to samples
     * @param {number} ms - Milliseconds
     * @param {number} sampleRate - Audio sample rate (default 44100)
     * @returns {number} Number of samples
     */
    static msToSamples(ms, sampleRate = 44100) {
        return Math.round((ms / 1000) * sampleRate);
    }

    /**
     * Convert samples to milliseconds
     * @param {number} samples - Number of samples
     * @param {number} sampleRate - Audio sample rate (default 44100)
     * @returns {number} Milliseconds
     */
    static samplesToMs(samples, sampleRate = 44100) {
        return (samples / sampleRate) * 1000;
    }

    /**
     * Calculate time difference with high precision
     * @param {number} startTime - Start timestamp
     * @param {number} endTime - End timestamp
     * @returns {number} Time difference in milliseconds
     */
    static getTimeDifference(startTime, endTime) {
        return endTime - startTime;
    }

    /**
     * Wait for a specified duration with high precision
     * @param {number} duration - Duration in milliseconds
     * @returns {Promise<void>} Promise that resolves after the duration
     */
    static async wait(duration) {
        return new Promise(resolve => {
            setTimeout(resolve, duration);
        });
    }

    /**
     * Wait for a high-precision duration using requestAnimationFrame
     * @param {number} duration - Duration in milliseconds
     * @returns {Promise<void>} Promise that resolves after the duration
     */
    static async waitPrecise(duration) {
        const startTime = performance.now();
        
        return new Promise(resolve => {
            const checkTime = () => {
                if (performance.now() - startTime >= duration) {
                    resolve();
                } else {
                    requestAnimationFrame(checkTime);
                }
            };
            checkTime();
        });
    }

    /**
     * Calculate clock drift between two timestamps
     * @param {number} localTime - Local timestamp
     * @param {number} remoteTime - Remote timestamp
     * @param {number} roundTripTime - Round trip time for the measurement
     * @returns {number} Drift in milliseconds
     */
    static calculateClockDrift(localTime, remoteTime, roundTripTime) {
        // Assuming symmetric latency
        const oneWayLatency = roundTripTime / 2;
        const correctedRemoteTime = remoteTime + oneWayLatency;
        return localTime - correctedRemoteTime;
    }

    /**
     * Calculate compensation for clock drift
     * @param {number} drift - Clock drift in milliseconds
     * @param {number} period - Period over which to apply compensation
     * @returns {number} Compensation factor
     */
    static calculateDriftCompensation(drift, period) {
        // Calculate how much to adjust timing
        return drift / period;
    }

    /**
     * Synchronize timestamp with audio buffer
     * @param {number} audioTime - Audio buffer time
     * @param {number} bufferDelay - Buffer processing delay
     * @param {number} outputDelay - Output device delay
     * @returns {number} Synchronized timestamp
     */
    static synchronizeTimestamp(audioTime, bufferDelay = 0, outputDelay = 0) {
        return audioTime + bufferDelay + outputDelay;
    }

    /**
     * Calculate lookahead time for synchronization
     * @param {number} bufferSize - Audio buffer size in samples
     * @param {number} sampleRate - Audio sample rate
     * @param {number} safetyMargin - Additional safety margin in milliseconds
     * @returns {number} Lookahead time in milliseconds
     */
    static calculateLookahead(bufferSize, sampleRate, safetyMargin = 10) {
        const bufferTime = this.samplesToMs(bufferSize, sampleRate);
        return bufferTime + safetyMargin;
    }

    /**
     * Format time for display
     * @param {number} timeMs - Time in milliseconds
     * @returns {string} Formatted time string
     */
    static formatTime(timeMs) {
        const ms = Math.floor(timeMs % 1000);
        const seconds = Math.floor((timeMs / 1000) % 60);
        const minutes = Math.floor((timeMs / (1000 * 60)) % 60);
        const hours = Math.floor(timeMs / (1000 * 60 * 60));

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
            return `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    /**
     * Calculate sample position from time and buffer settings
     * @param {number} time - Time in milliseconds
     * @param {number} bufferSize - Audio buffer size
     * @param {number} writePosition - Current write position
     * @returns {number} Sample position in buffer
     */
    static calculateSamplePosition(time, bufferSize, writePosition) {
        const samples = this.msToSamples(time);
        return (writePosition + samples) % bufferSize;
    }

    /**
     * Validate time synchronization tolerance
     * @param {number} time1 - First timestamp
     * @param {number} time2 - Second timestamp
     * @param {number} tolerance - Maximum allowed difference in milliseconds
     * @returns {boolean} True if within tolerance
     */
    static isWithinTolerance(time1, time2, tolerance = 1) {
        return Math.abs(time1 - time2) <= tolerance;
    }

    /**
     * Create a high-resolution timer
     * @returns {object} Timer object with start, stop, and getElapsed methods
     */
    static createTimer() {
        return {
            startTime: null,
            
            start() {
                this.startTime = performance.now();
            },
            
            stop() {
                if (this.startTime === null) {
                    throw new Error('Timer not started');
                }
                return performance.now() - this.startTime;
            },
            
            getElapsed() {
                if (this.startTime === null) {
                    throw new Error('Timer not started');
                }
                return performance.now() - this.startTime;
            },
            
            reset() {
                this.startTime = null;
            }
        };
    }

    /**
     * Perform time-stamped measurement
     * @param {Function} operation - Operation to measure
     * @returns {Promise<{result: any, duration: number}>} Result and duration
     */
    static async measureTime(operation) {
        const timer = this.createTimer();
        timer.start();
        
        try {
            const result = await operation();
            const duration = timer.stop();
            return { result, duration };
        } catch (error) {
            timer.stop();
            throw error;
        }
    }
}

export { TimeUtils };