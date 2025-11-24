import { EventEmitter } from '../utils/EventEmitter.js';
import { TimeUtils } from '../utils/TimeUtils.js';
import { logger } from '../utils/Logger.js';

/**
 * MasterClock provides the central timing mechanism for audio synchronization
 * across multiple Bluetooth devices
 */
class MasterClock extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.startTime = null;
        this.paused = false;
        this.pauseTime = null;
        this.totalPausedTime = 0;
        
        // Configuration options
        this.tickInterval = options.tickInterval || 10; // 10ms tick interval
        this.lookahead = options.lookahead || 100; // 100ms lookahead
        this.syncTolerance = options.syncTolerance || 1; // 1ms tolerance
        
        // State tracking
        this.subscribers = new Map();
        this.timers = new Set();
        this.isRunning = false;
        
        // Performance monitoring
        this.tickCount = 0;
        this.lastTickTime = null;
        this.avgTickDuration = 0;
        
        this.log = logger.createScopedLogger('MasterClock');
    }

    /**
     * Start the master clock
     */
    start() {
        if (this.isRunning) {
            this.log.warn('Master clock is already running');
            return;
        }
        
        this.startTime = performance.now();
        this.isRunning = true;
        this.paused = false;
        this.totalPausedTime = 0;
        
        this.log.info('Master clock started', {
            startTime: this.startTime,
            tickInterval: this.tickInterval
        });
        
        this.emit('started', { startTime: this.startTime });
        this._startTicking();
    }

    /**
     * Stop the master clock
     */
    stop() {
        if (!this.isRunning) {
            this.log.warn('Master clock is not running');
            return;
        }
        
        this._stopTicking();
        this.isRunning = false;
        this.startTime = null;
        this.paused = false;
        
        this.log.info('Master clock stopped', {
            totalTicks: this.tickCount,
            avgTickDuration: this.avgTickDuration
        });
        
        this.emit('stopped', { totalTicks: this.tickCount });
    }

    /**
     * Pause the master clock
     */
    pause() {
        if (!this.isRunning || this.paused) {
            return;
        }
        
        this.paused = true;
        this.pauseTime = performance.now();
        
        this.log.debug('Master clock paused');
        this.emit('paused', { pauseTime: this.pauseTime });
    }

    /**
     * Resume the master clock
     */
    resume() {
        if (!this.isRunning || !this.paused) {
            return;
        }
        
        const currentTime = performance.now();
        this.totalPausedTime += currentTime - this.pauseTime;
        this.paused = false;
        this.pauseTime = null;
        
        this.log.debug('Master clock resumed', {
            pausedDuration: this.totalPausedTime
        });
        this.emit('resumed', { totalPausedTime: this.totalPausedTime });
    }

    /**
     * Get the current synchronized time
     * @returns {number} Current time in milliseconds
     */
    getCurrentTime() {
        if (!this.isRunning) {
            return 0;
        }
        
        const now = performance.now();
        let elapsed = now - this.startTime;
        
        // Subtract total paused time
        if (this.paused && this.pauseTime) {
            elapsed -= (this.pauseTime - this.startTime) - this.totalPausedTime;
        } else {
            elapsed -= this.totalPausedTime;
        }
        
        return Math.max(0, elapsed);
    }

    /**
     * Get the time with lookahead for synchronization
     * @returns {number} Time with lookahead in milliseconds
     */
    getSyncTime() {
        return this.getCurrentTime() + this.lookahead;
    }

    /**
     * Subscribe to clock updates
     * @param {string} id - Subscriber ID
     * @param {Function} callback - Callback function
     * @param {number} interval - Update interval in milliseconds (optional)
     */
    subscribe(id, callback, interval = null) {
        if (typeof id !== 'string' || typeof callback !== 'function') {
            throw new Error('Invalid subscriber parameters');
        }
        
        const subscriber = {
            callback,
            interval,
            lastUpdate: 0
        };
        
        this.subscribers.set(id, subscriber);
        
        this.log.debug('Clock subscriber added', { id, interval });
        this.emit('subscribed', { id, interval });
    }

    /**
     * Unsubscribe from clock updates
     * @param {string} id - Subscriber ID
     */
    unsubscribe(id) {
        if (this.subscribers.has(id)) {
            this.subscribers.delete(id);
            
            this.log.debug('Clock subscriber removed', { id });
            this.emit('unsubscribed', { id });
        }
    }

    /**
     * Schedule a one-time callback at a specific time
     * @param {number} targetTime - Target time in milliseconds
     * @param {Function} callback - Callback function
     * @returns {string} Timer ID
     */
    scheduleCallback(targetTime, callback) {
        const timerId = this._generateTimerId();
        const delay = Math.max(0, targetTime - this.getCurrentTime());
        
        const timer = setTimeout(() => {
            try {
                callback(this.getCurrentTime());
            } catch (error) {
                this.log.error('Error in scheduled callback', { error, timerId });
            }
            this.timers.delete(timerId);
        }, delay);
        
        this.timers.add(timerId);
        
        this.log.debug('Callback scheduled', { 
            timerId, 
            targetTime, 
            delay 
        });
        
        return timerId;
    }

    /**
     * Schedule a recurring callback
     * @param {number} interval - Interval in milliseconds
     * @param {Function} callback - Callback function
     * @returns {string} Timer ID
     */
    scheduleRecurring(interval, callback) {
        const timerId = this._generateTimerId();
        
        const timer = setInterval(() => {
            if (!this.paused) {
                try {
                    callback(this.getCurrentTime());
                } catch (error) {
                    this.log.error('Error in recurring callback', { 
                        error, 
                        timerId 
                    });
                }
            }
        }, interval);
        
        this.timers.add(timer);
        
        this.log.debug('Recurring callback scheduled', { 
            timerId, 
            interval 
        });
        
        return timer;
    }

    /**
     * Cancel a scheduled timer
     * @param {string} timerId - Timer ID
     */
    cancelTimer(timerId) {
        // Note: setTimeout/interval objects can't be directly matched
        // This is a simplified implementation
        clearTimeout(timerId);
        clearInterval(timerId);
        this.timers.delete(timerId);
        
        this.log.debug('Timer cancelled', { timerId });
    }

    /**
     * Get clock statistics
     * @returns {object} Clock statistics
     */
    getStats() {
        return {
            isRunning: this.isRunning,
            isPaused: this.paused,
            currentTime: this.getCurrentTime(),
            tickCount: this.tickCount,
            avgTickDuration: this.avgTickDuration,
            subscriberCount: this.subscribers.size,
            activeTimerCount: this.timers.size
        };
    }

    /**
     * Set clock options
     * @param {object} options - Configuration options
     */
    setOptions(options) {
        const wasRunning = this.isRunning;
        
        if (wasRunning) {
            this.stop();
        }
        
        if (options.tickInterval !== undefined) {
            this.tickInterval = options.tickInterval;
        }
        
        if (options.lookahead !== undefined) {
            this.lookahead = options.lookahead;
        }
        
        if (options.syncTolerance !== undefined) {
            this.syncTolerance = options.syncTolerance;
        }
        
        if (wasRunning) {
            this.start();
        }
        
        this.log.info('Clock options updated', options);
    }

    /**
     * Start the clock ticking loop
     * @private
     */
    _startTicking() {
        const tick = () => {
            if (!this.isRunning) {
                return;
            }
            
            const startTick = performance.now();
            
            if (!this.paused) {
                this._processTick();
            }
            
            const tickDuration = performance.now() - startTick;
            this._updateTickStats(tickDuration);
            
            const nextTickDelay = Math.max(0, this.tickInterval - tickDuration);
            
            setTimeout(() => {
                if (this.isRunning) {
                    requestAnimationFrame(tick);
                }
            }, nextTickDelay);
        };
        
        requestAnimationFrame(tick);
        this.log.debug('Clock ticking started');
    }

    /**
     * Stop the clock ticking loop
     * @private
     */
    _stopTicking() {
        // Clear all timers
        for (const timer of this.timers) {
            clearTimeout(timer);
            clearInterval(timer);
        }
        this.timers.clear();
        
        this.log.debug('Clock ticking stopped');
    }

    /**
     * Process a clock tick
     * @private
     */
    _processTick() {
        const currentTime = this.getCurrentTime();
        this.lastTickTime = currentTime;
        
        // Update subscribers
        for (const [id, subscriber] of this.subscribers) {
            if (!subscriber.interval || 
                currentTime - subscriber.lastUpdate >= subscriber.interval) {
                try {
                    subscriber.callback(currentTime);
                    subscriber.lastUpdate = currentTime;
                } catch (error) {
                    this.log.error('Error in subscriber callback', { 
                        id, 
                        error 
                    });
                }
            }
        }
        
        // Emit tick event
        this.emit('tick', { 
            time: currentTime, 
            tickCount: this.tickCount 
        });
        
        this.tickCount++;
    }

    /**
     * Update tick statistics
     * @param {number} duration - Tick duration in milliseconds
     * @private
     */
    _updateTickStats(duration) {
        // Calculate running average of tick duration
        const alpha = 0.1; // Smoothing factor
        this.avgTickDuration = this.avgTickDuration === 0 ? 
            duration : 
            (alpha * duration + (1 - alpha) * this.avgTickDuration);
    }

    /**
     * Generate a unique timer ID
     * @returns {string} Timer ID
     * @private
     */
    _generateTimerId() {
        return `timer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

export { MasterClock };