/**
 * Centralized logging system for the Web Bluetooth Audio Sync application
 */
class Logger {
    constructor(options = {}) {
        this.logLevel = options.logLevel || 'INFO';
        this.enableConsole = options.enableConsole !== false;
        this.enableFile = options.enableFile || false;
        this.maxLogSize = options.maxLogSize || 1000;
        
        this.logLevels = {
            DEBUG: 0,
            INFO: 1,
            WARN: 2,
            ERROR: 3
        };
        
        this.currentLevel = this.logLevels[this.logLevel] || this.logLevels.INFO;
        this.logBuffer = [];
    }

    /**
     * Set the logging level
     * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
     */
    setLogLevel(level) {
        if (this.logLevels.hasOwnProperty(level)) {
            this.logLevel = level;
            this.currentLevel = this.logLevels[level];
        }
    }

    /**
     * Create a log entry
     * @param {string} level - Log level
     * @param {string} component - Component name
     * @param {string} message - Log message
     * @param {object} data - Additional data
     */
    _log(level, component, message, data = null) {
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            component,
            message,
            data
        };

        // Add to buffer
        this.logBuffer.push(logEntry);
        
        // Maintain buffer size
        if (this.logBuffer.length > this.maxLogSize) {
            this.logBuffer.shift();
        }

        // Output to console
        if (this.enableConsole) {
            this._outputToConsole(logEntry);
        }

        // Output to file (if implemented)
        if (this.enableFile) {
            this._outputToFile(logEntry);
        }
    }

    /**
     * Output log entry to console
     * @param {object} logEntry - Log entry object
     */
    _outputToConsole(logEntry) {
        const { level, component, message, data } = logEntry;
        const prefix = `[${logEntry.timestamp}] [${level}] [${component}]`;
        
        switch (level) {
            case 'DEBUG':
                if (data) {
                    console.debug(prefix, message, data);
                } else {
                    console.debug(prefix, message);
                }
                break;
            case 'INFO':
                if (data) {
                    console.info(prefix, message, data);
                } else {
                    console.info(prefix, message);
                }
                break;
            case 'WARN':
                if (data) {
                    console.warn(prefix, message, data);
                } else {
                    console.warn(prefix, message);
                }
                break;
            case 'ERROR':
                if (data) {
                    console.error(prefix, message, data);
                } else {
                    console.error(prefix, message);
                }
                break;
        }
    }

    /**
     * Output log entry to file (placeholder for future implementation)
     * @param {object} logEntry - Log entry object
     */
    _outputToFile(logEntry) {
        // Future implementation for file logging
        // Could use Web Workers and IndexedDB for persistent logging
    }

    /**
     * Debug level logging
     * @param {string} component - Component name
     * @param {string} message - Log message
     * @param {object} data - Additional data
     */
    debug(component, message, data = null) {
        if (this.currentLevel <= this.logLevels.DEBUG) {
            this._log('DEBUG', component, message, data);
        }
    }

    /**
     * Info level logging
     * @param {string} component - Component name
     * @param {string} message - Log message
     * @param {object} data - Additional data
     */
    info(component, message, data = null) {
        if (this.currentLevel <= this.logLevels.INFO) {
            this._log('INFO', component, message, data);
        }
    }

    /**
     * Warning level logging
     * @param {string} component - Component name
     * @param {string} message - Log message
     * @param {object} data - Additional data
     */
    warn(component, message, data = null) {
        if (this.currentLevel <= this.logLevels.WARN) {
            this._log('WARN', component, message, data);
        }
    }

    /**
     * Error level logging
     * @param {string} component - Component name
     * @param {string} message - Log message
     * @param {object} data - Additional data
     */
    error(component, message, data = null) {
        this._log('ERROR', component, message, data);
    }

    /**
     * Get recent log entries
     * @param {number} count - Number of entries to retrieve
     * @returns {Array<object>} Recent log entries
     */
    getRecentLogs(count = 100) {
        return this.logBuffer.slice(-count);
    }

    /**
     * Clear the log buffer
     */
    clearLogs() {
        this.logBuffer = [];
    }

    /**
     * Export logs as JSON
     * @returns {string} JSON representation of logs
     */
    exportLogs() {
        return JSON.stringify(this.logBuffer, null, 2);
    }

    /**
     * Performance timing helper
     * @param {string} component - Component name
     * @param {string} operation - Operation name
     * @param {number} duration - Duration in milliseconds
     */
    timing(component, operation, duration) {
        this.debug('TIMING', `${component}:${operation}`, { duration });
    }

    /**
     * Create a scoped logger for a specific component
     * @param {string} componentName - Component name
     * @returns {object} Scoped logger object
     */
    createScopedLogger(componentName) {
        return {
            debug: (message, data = null) => this.debug(componentName, message, data),
            info: (message, data = null) => this.info(componentName, message, data),
            warn: (message, data = null) => this.warn(componentName, message, data),
            error: (message, data = null) => this.error(componentName, message, data),
            timing: (operation, duration) => this.timing(componentName, operation, duration)
        };
    }
}

// Create global logger instance
const logger = new Logger({
    logLevel: 'DEBUG',
    enableConsole: true,
    enableFile: false,
    maxLogSize: 500
});

// Export for use in other modules
export { Logger, logger };