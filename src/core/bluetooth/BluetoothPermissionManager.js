import { EventEmitter } from '../utils/EventEmitter.js';
import { logger } from '../utils/Logger.js';

/**
 * BluetoothPermissionManager handles security requirements and user permission flows
 * for Web Bluetooth API operations
 */
class BluetoothPermissionManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.isSecureContext = window.location.protocol === 'https:' ||
                                window.location.hostname === 'localhost' ||
                                window.location.hostname === '127.0.0.1';
        
        this.supported = !!navigator.bluetooth;
        
        // Permission state tracking
        this.permissionStates = new Map();
        this.pendingRequests = new Map();
        
        // Configuration
        this.requestTimeout = options.requestTimeout || 30000; // 30 seconds
        this.maxRetries = options.maxRetries || 3;
        this.autoRetry = options.autoRetry !== false;
        
        // Security validation
        this.securityChecks = {
            secureContext: this.isSecureContext,
            webBluetoothSupported: this.supported,
            userAgentCheck: this._checkUserAgentSupport()
        };
        
        this.log = logger.createScopedLogger('BluetoothPermissionManager');
        
        this._validateEnvironment();
    }

    /**
     * Request device connection with proper security validation
     * @param {object} deviceConfig - Device configuration
     * @returns {Promise<object>} Device connection result
     */
    async requestDeviceConnection(deviceConfig) {
        this.log.info('Requesting device connection', { deviceConfig });
        
        // Validate security context
        this._validateSecurityContext();
        
        // Validate device configuration
        this._validateDeviceConfig(deviceConfig);
        
        const requestId = this._generateRequestId();
        const requestState = {
            id: requestId,
            config: deviceConfig,
            startTime: Date.now(),
            retryCount: 0,
            status: 'pending'
        };
        
        this.pendingRequests.set(requestId, requestState);
        
        try {
            this.emit('requestStarted', { requestId, deviceConfig });
            
            const device = await this._performDeviceRequest(deviceConfig, requestId);
            
            // Set up device event listeners
            this._setupDeviceEventListeners(device, requestId);
            
            requestState.status = 'completed';
            requestState.device = device;
            
            this.log.info('Device connection successful', { 
                requestId, 
                deviceId: device.id 
            });
            
            this.emit('requestCompleted', { 
                requestId, 
                device, 
                deviceConfig 
            });
            
            return {
                success: true,
                device,
                requestId,
                timestamp: Date.now()
            };
            
        } catch (error) {
            requestState.status = 'failed';
            requestState.error = error;
            
            this.log.error('Device connection failed', { 
                requestId, 
                error: error.message 
            });
            
            this.emit('requestFailed', { 
                requestId, 
                error, 
                deviceConfig 
            });
            
            // Retry logic
            if (this.autoRetry && requestState.retryCount < this.maxRetries) {
                return await this._retryRequest(requestState);
            }
            
            throw new BluetoothPermissionError(
                `Failed to connect to device: ${error.message}`,
                error
            );
            
        } finally {
            this.pendingRequests.delete(requestId);
        }
    }

    /**
     * Check if a specific device is already connected
     * @param {string} deviceId - Device identifier
     * @returns {boolean} True if device is connected
     */
    isDeviceConnected(deviceId) {
        // Check active devices
        const connectedDevices = navigator.bluetooth.getDevices?.() || [];
        return connectedDevices.some(device => device.id === deviceId);
    }

    /**
     * Get permission status for a specific service
     * @param {string} serviceUuid - Service UUID
     * @returns {string} Permission status
     */
    getServicePermissionStatus(serviceUuid) {
        const key = `service:${serviceUuid}`;
        return this.permissionStates.get(key) || 'unknown';
    }

    /**
     * Request permission for a specific service
     * @param {string} serviceUuid - Service UUID
     * @returns {Promise<boolean>} Permission granted
     */
    async requestServicePermission(serviceUuid) {
        try {
            // Request device with specific service
            const device = await navigator.bluetooth.requestDevice({
                filters: [],
                optionalServices: [serviceUuid]
            });
            
            const gattServer = await device.gatt.connect();
            const service = await gattServer.getPrimaryService(serviceUuid);
            
            // Permission granted if we can access the service
            this.permissionStates.set(`service:${serviceUuid}`, 'granted');
            
            this.log.info('Service permission granted', { serviceUuid });
            
            // Clean up connection
            await gattServer.disconnect();
            
            return true;
            
        } catch (error) {
            this.permissionStates.set(`service:${serviceUuid}`, 'denied');
            this.log.warn('Service permission denied', { serviceUuid, error: error.message });
            return false;
        }
    }

    /**
     * Get security status summary
     * @returns {object} Security status
     */
    getSecurityStatus() {
        return {
            secureContext: this.securityChecks.secureContext,
            webBluetoothSupported: this.securityChecks.webBluetoothSupported,
            userAgentSupported: this.securityChecks.userAgentCheck,
            isSecure: this.isSecure(),
            environment: {
                protocol: window.location.protocol,
                hostname: window.location.hostname,
                userAgent: navigator.userAgent
            }
        };
    }

    /**
     * Check if current environment is secure for Web Bluetooth
     * @returns {boolean} True if secure
     */
    isSecure() {
        return this.securityChecks.secureContext && 
               this.securityChecks.webBluetoothSupported && 
               this.securityChecks.userAgentCheck;
    }

    /**
     * Show user-friendly error messages
     * @param {Error} error - Error object
     * @returns {string} User-friendly error message
     */
    getUserFriendlyError(error) {
        if (error.name === 'NotFoundError') {
            return 'No suitable Bluetooth device found. Please make sure your device is discoverable and try again.';
        }
        
        if (error.name === 'NotAllowedError') {
            return 'Bluetooth connection was cancelled or not allowed. Please try again and grant the necessary permissions.';
        }
        
        if (error.name === 'NotSupportedError') {
            return 'This browser or device does not support Web Bluetooth. Please use Chrome, Edge, or Safari on a secure (HTTPS) connection.';
        }
        
        if (error.name === 'SecurityError') {
            return 'Security error occurred. Please ensure you are using a secure (HTTPS) connection and try again.';
        }
        
        if (error instanceof BluetoothPermissionError) {
            return `Bluetooth permission error: ${error.message}`;
        }
        
        return `An unexpected error occurred: ${error.message}`;
    }

    /**
     * Cancel all pending requests
     */
    cancelAllRequests() {
        for (const [requestId, requestState] of this.pendingRequests) {
            this.log.info('Cancelling pending request', { requestId });
            this.emit('requestCancelled', { requestId, requestState });
        }
        this.pendingRequests.clear();
    }

    /**
     * Validate current security context
     * @private
     */
    _validateSecurityContext() {
        if (!this.securityChecks.secureContext) {
            throw new BluetoothPermissionError(
                'Web Bluetooth requires a secure context (HTTPS or localhost)'
            );
        }
        
        if (!this.securityChecks.webBluetoothSupported) {
            throw new BluetoothPermissionError(
                'Web Bluetooth is not supported in this browser'
            );
        }
    }

    /**
     * Validate device configuration
     * @param {object} config - Device configuration
     * @private
     */
    _validateDeviceConfig(config) {
        if (!config || typeof config !== 'object') {
            throw new BluetoothPermissionError('Invalid device configuration');
        }
        
        if (!config.filter && !config.acceptAllDevices) {
            throw new BluetoothPermissionError(
                'Device configuration must include either filters or acceptAllDevices'
            );
        }
        
        if (config.filters && !Array.isArray(config.filters)) {
            throw new BluetoothPermissionError('Filters must be an array');
        }
        
        if (config.optionalServices && !Array.isArray(config.optionalServices)) {
            throw new BluetoothPermissionError('Optional services must be an array');
        }
    }

    /**
     * Perform the actual device request
     * @param {object} deviceConfig - Device configuration
     * @param {string} requestId - Request identifier
     * @returns {Promise<object>} Bluetooth device
     * @private
     */
    async _performDeviceRequest(deviceConfig, requestId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new BluetoothPermissionError(
                    'Device request timed out. Please try again.'
                ));
            }, this.requestTimeout);
            
            try {
                const devicePromise = navigator.bluetooth.requestDevice(deviceConfig);
                
                devicePromise.then(device => {
                    clearTimeout(timeout);
                    resolve(device);
                }).catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
                
            } catch (error) {
                clearTimeout(timeout);
                reject(new BluetoothPermissionError(
                    `Device request failed: ${error.message}`,
                    error
                ));
            }
        });
    }

    /**
     * Set up device event listeners
     * @param {object} device - Bluetooth device
     * @param {string} requestId - Request identifier
     * @private
     */
    _setupDeviceEventListeners(device, requestId) {
        device.addEventListener('gattserverdisconnected', (event) => {
            this.log.info('Device disconnected', { 
                deviceId: device.id, 
                requestId 
            });
            
            this.emit('deviceDisconnected', { 
                device, 
                requestId, 
                reason: event.reason 
            });
        });
        
        // Store device reference for cleanup
        this.emit('deviceConnected', { 
            device, 
            requestId 
        });
    }

    /**
     * Retry a failed request
     * @param {object} requestState - Request state object
     * @returns {Promise<object>} Retry result
     * @private
     */
    async _retryRequest(requestState) {
        requestState.retryCount++;
        
        this.log.info('Retrying device request', { 
            requestId: requestState.id,
            retryCount: requestState.retryCount 
        });
        
        this.emit('requestRetrying', { 
            requestId: requestState.id,
            retryCount: requestState.retryCount 
        });
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 1000 * requestState.retryCount));
        
        try {
            return await this.requestDeviceConnection(requestState.config);
        } catch (error) {
            this.log.error('Retry failed', { 
                requestId: requestState.id,
                error: error.message 
            });
            throw error;
        }
    }

    /**
     * Check user agent for Web Bluetooth support
     * @returns {boolean} User agent support status
     * @private
     */
    _checkUserAgentSupport() {
        const userAgent = navigator.userAgent.toLowerCase();
        
        // Chrome/Edge (Chromium-based)
        const isChrome = userAgent.includes('chrome') && !userAgent.includes('edg');
        const isEdge = userAgent.includes('edg');
        
        // Safari (with Web Bluetooth support)
        const isSafari = userAgent.includes('safari') && !userAgent.includes('chrome');
        
        // Firefox (experimental support)
        const isFirefox = userAgent.includes('firefox');
        
        // Known limitations
        const isMobileSafari = isSafari && (
            userAgent.includes('iphone') || 
            userAgent.includes('ipad') || 
            userAgent.includes('ipod')
        );
        
        // Web Bluetooth support matrix
        if (isChrome || isEdge) {
            return true; // Full support
        }
        
        if (isSafari && !isMobileSafari) {
            return true; // Limited support in newer Safari versions
        }
        
        if (isFirefox) {
            return false; // No support (behind flags)
        }
        
        // Default to false for unknown browsers
        return false;
    }

    /**
     * Validate the overall environment
     * @private
     */
    _validateEnvironment() {
        this.log.info('Validating Web Bluetooth environment', this.securityChecks);
        
        if (!this.isSecure()) {
            this.log.warn('Environment is not secure for Web Bluetooth');
        }
        
        if (!this.supported) {
            this.log.warn('Web Bluetooth is not supported in this browser');
        }
    }

    /**
     * Generate a unique request ID
     * @returns {string} Unique request identifier
     * @private
     */
    _generateRequestId() {
        return `bt_request_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

/**
 * Custom error class for Bluetooth permission errors
 */
class BluetoothPermissionError extends Error {
    constructor(message, originalError = null) {
        super(message);
        this.name = 'BluetoothPermissionError';
        this.originalError = originalError;
    }
}

export { BluetoothPermissionManager, BluetoothPermissionError };