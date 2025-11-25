import { EventEmitter } from '../utils/EventEmitter.js';
import { BluetoothPermissionManager } from './BluetoothPermissionManager.js';
import { logger } from '../utils/Logger.js';

/**
 * DeviceManager handles device discovery, connection management, and service discovery
 * for Web Bluetooth audio synchronization
 */
class DeviceManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Core components
        this.permissionManager = new BluetoothPermissionManager();
        
        // Device state management
        this.devices = new Map(); // deviceId -> device state
        this.connectionStates = new Map(); // deviceId -> connection state
        
        // Configuration
        this.autoReconnect = options.autoReconnect !== false;
        this.connectionTimeout = options.connectionTimeout || 10000; // 10 seconds
        this.serviceDiscoveryTimeout = options.serviceDiscoveryTimeout || 5000; // 5 seconds
        this.maxConcurrentConnections = options.maxConcurrentConnections || 5;
        
        // Connection pool
        this.connectionPool = [];
        this.pendingConnections = new Set();
        
        // Performance tracking
        this.connectionStats = {
            totalAttempts: 0,
            successfulConnections: 0,
            failedConnections: 0,
            averageConnectionTime: 0
        };
        
        this.log = logger.createScopedLogger('DeviceManager');
        
        this._setupEventHandlers();
    }

    /**
     * Connect to multiple devices with load balancing
     * @param {Array} deviceConfigs - Array of device configurations
     * @param {object} options - Connection options
     * @returns {Promise<Array>} Array of connection results
     */
    async connectMultipleDevices(deviceConfigs, options = {}) {
        const maxConcurrent = Math.min(
            options.maxConcurrent || this.maxConcurrentConnections,
            deviceConfigs.length
        );
        
        this.log.info('Connecting to multiple devices', {
            totalDevices: deviceConfigs.length,
            maxConcurrent
        });
        
        const results = [];
        const batches = this._createConnectionBatches(deviceConfigs, maxConcurrent);
        
        for (const batch of batches) {
            const batchPromises = batch.map(config => 
                this.connectDevice(config, options).catch(error => ({
                    success: false,
                    error: error.message,
                    config
                }))
            );
            
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
        }
        
        const successCount = results.filter(r => r.success).length;
        this.log.info('Multiple device connection completed', {
            total: deviceConfigs.length,
            successful: successCount,
            failed: deviceConfigs.length - successCount
        });
        
        return results;
    }

    /**
     * Connect to a single device
     * @param {object} deviceConfig - Device configuration
     * @param {object} options - Connection options
     * @returns {Promise<object>} Connection result
     */
    async connectDevice(deviceConfig, options = {}) {
        const connectionId = this._generateConnectionId();

        this.log.info('Connecting to device', {
            connectionId,
            deviceConfig: this._sanitizeConfig(deviceConfig)
        });

        this.emit('connectionStarted', { connectionId, deviceConfig });
        
        try {
            this.log.debug('Requesting device connection from permission manager', {
                deviceConfig: this._sanitizeConfig(deviceConfig)
            });

            // Request device connection
            const deviceResult = await this.permissionManager.requestDeviceConnection(deviceConfig);
            const device = deviceResult.device;

            this.log.debug('Device connection result', {
                success: deviceResult.success,
                hasDevice: !!device,
                deviceId: device?.id || 'none'
            });
            
            // Update connection state
            this.connectionStates.set(device.id, {
                id: connectionId,
                status: 'connecting',
                startTime: Date.now(),
                config: deviceConfig,
                attempt: 1
            });
            
            // Connect to GATT server
            const gattServer = await this._connectToGattServer(device, connectionId);
            
            // Discover services
            const services = await this._discoverServices(gattServer, connectionId, options.services);
            
            // Set up device state
            const deviceState = {
                id: device.id,
                device,
                gattServer,
                services,
                config: deviceConfig,
                connected: true,
                lastActivity: Date.now(),
                quality: 'unknown'
            };
            
            this.devices.set(device.id, deviceState);
            this.connectionStates.set(device.id, {
                ...this.connectionStates.get(device.id),
                status: 'connected',
                endTime: Date.now(),
                services: services.length
            });
            
            // Set up disconnection handling
            this._setupDeviceDisconnectionHandler(device.id, device);
            
            // Update statistics
            this._updateConnectionStats(true, Date.now() - this.connectionStates.get(device.id).startTime);
            
            this.log.info('Device connected successfully', {
                connectionId,
                deviceId: device.id,
                serviceCount: services.length
            });
            
            this.emit('deviceConnected', {
                connectionId,
                device,
                deviceState,
                services
            });
            
            return {
                success: true,
                device,
                deviceState,
                services,
                connectionId
            };
            
        } catch (error) {
            this.connectionStates.set(device.id, {
                ...this.connectionStates.get(device.id),
                status: 'failed',
                endTime: Date.now(),
                error: error.message
            });
            
            this._updateConnectionStats(false);
            
            this.log.error('Device connection failed', {
                connectionId,
                error: error.message
            });
            
            this.emit('connectionFailed', {
                connectionId,
                error,
                deviceConfig
            });
            
            throw error;
        }
    }

    /**
     * Disconnect a device
     * @param {string} deviceId - Device identifier
     * @returns {Promise<boolean>} True if disconnection successful
     */
    async disconnectDevice(deviceId) {
        const deviceState = this.devices.get(deviceId);
        
        if (!deviceState) {
            this.log.warn('Device not found for disconnection', { deviceId });
            return false;
        }
        
        this.log.info('Disconnecting device', { deviceId });
        
        try {
            // Disconnect GATT server
            if (deviceState.gattServer) {
                await deviceState.gattServer.disconnect();
            }
            
            // Clean up device state
            this.devices.delete(deviceId);
            this.connectionStates.delete(deviceId);
            
            this.emit('deviceDisconnected', { deviceId });
            
            this.log.info('Device disconnected successfully', { deviceId });
            
            return true;
            
        } catch (error) {
            this.log.error('Device disconnection error', { 
                deviceId, 
                error: error.message 
            });
            
            // Clean up state anyway
            this.devices.delete(deviceId);
            this.connectionStates.delete(deviceId);
            
            return false;
        }
    }

    /**
     * Get all connected devices
     * @returns {Array} Array of connected devices
     */
    getConnectedDevices() {
        return Array.from(this.devices.values()).map(state => ({
            id: state.id,
            device: state.device,
            connected: state.connected,
            quality: state.quality,
            lastActivity: state.lastActivity
        }));
    }

    /**
     * Get device connection state
     * @param {string} deviceId - Device identifier
     * @returns {object} Connection state
     */
    getDeviceConnectionState(deviceId) {
        return this.connectionStates.get(deviceId);
    }

    /**
     * Check if device is connected
     * @param {string} deviceId - Device identifier
     * @returns {boolean} True if connected
     */
    isDeviceConnected(deviceId) {
        const deviceState = this.devices.get(deviceId);
        return deviceState && deviceState.connected && deviceState.gattServer?.connected;
    }

    /**
     * Get connection statistics
     * @returns {object} Connection statistics
     */
    getConnectionStats() {
        return {
            ...this.connectionStats,
            connectedDevices: this.devices.size,
            pendingConnections: this.pendingConnections.size,
            connectionStates: Object.fromEntries(this.connectionStates)
        };
    }

    /**
     * Set device quality
     * @param {string} deviceId - Device identifier
     * @param {string} quality - Quality level
     */
    setDeviceQuality(deviceId, quality) {
        const deviceState = this.devices.get(deviceId);
        if (deviceState) {
            deviceState.quality = quality;
            deviceState.lastActivity = Date.now();
            
            this.emit('deviceQualityChanged', { deviceId, quality });
        }
    }

    /**
     * Scan for available Bluetooth devices (simulation for demo)
     * @param {object} scanOptions - Scan options
     * @returns {Promise<Array>} Array of available devices
     */
    async scanForDevices(scanOptions = {}) {
        this.log.info('Scanning for Bluetooth devices', scanOptions);

        // Note: Web Bluetooth doesn't support device scanning like classic Bluetooth
        // This is a simulation for demo purposes
        const simulatedDevices = [
            {
                id: 'sim_device_1',
                name: 'Bluetooth Speaker 1',
                type: 'audio_output',
                signalStrength: -45,
                battery: 85,
                isSimulated: true
            },
            {
                id: 'sim_device_2',
                name: 'Bluetooth Speaker 2',
                type: 'audio_output',
                signalStrength: -52,
                battery: 67,
                isSimulated: true
            },
            {
                id: 'sim_device_3',
                name: 'Wireless Headphones',
                type: 'audio_output',
                signalStrength: -38,
                battery: 92,
                isSimulated: true
            }
        ];

        this.emit('deviceScanCompleted', { devices: simulatedDevices });

        return simulatedDevices;
    }

    /**
     * Connect to GATT server
     * @param {object} device - Bluetooth device
     * @param {string} connectionId - Connection identifier
     * @returns {Promise<object>} GATT server
     * @private
     */
    async _connectToGattServer(device, connectionId) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`GATT connection timeout for device ${device.id}`));
            }, this.connectionTimeout);
            
            device.gatt.connect()
                .then(server => {
                    clearTimeout(timeout);
                    resolve(server);
                })
                .catch(error => {
                    clearTimeout(timeout);
                    reject(error);
                });
        });
    }

    /**
     * Discover services on GATT server
     * @param {object} gattServer - GATT server
     * @param {string} connectionId - Connection identifier
     * @param {Array} requiredServices - Required service UUIDs
     * @returns {Promise<Array>} Array of discovered services
     * @private
     */
    async _discoverServices(gattServer, connectionId, requiredServices = []) {
        const timeout = setTimeout(() => {
            throw new Error(`Service discovery timeout for connection ${connectionId}`);
        }, this.serviceDiscoveryTimeout);
        
        try {
            let services = [];
            
            if (requiredServices.length > 0) {
                // Discover specific services
                for (const serviceUuid of requiredServices) {
                    try {
                        const service = await gattServer.getPrimaryService(serviceUuid);
                        services.push(service);
                    } catch (error) {
                        this.log.warn('Required service not found', { 
                            serviceUuid, 
                            connectionId 
                        });
                    }
                }
            } else {
                // Discover all services
                services = await gattServer.getPrimaryServices();
            }
            
            clearTimeout(timeout);
            
            this.log.debug('Services discovered', { 
                connectionId, 
                serviceCount: services.length 
            });
            
            return services;
            
        } catch (error) {
            clearTimeout(timeout);
            throw error;
        }
    }

    /**
     * Set up device disconnection handler
     * @param {string} deviceId - Device identifier
     * @param {object} device - Bluetooth device
     * @private
     */
    _setupDeviceDisconnectionHandler(deviceId, device) {
        device.addEventListener('gattserverdisconnected', () => {
            this.log.info('Device disconnected event', { deviceId });
            
            // Clean up device state
            this.devices.delete(deviceId);
            this.connectionStates.delete(deviceId);
            
            this.emit('deviceDisconnected', { deviceId });
            
            // Auto-reconnect if enabled
            if (this.autoReconnect) {
                this._attemptAutoReconnect(deviceId, device);
            }
        });
    }

    /**
     * Attempt automatic reconnection
     * @param {string} deviceId - Device identifier
     * @param {object} device - Bluetooth device
     * @private
     */
    async _attemptAutoReconnect(deviceId, device) {
        this.log.info('Attempting auto-reconnect', { deviceId });
        
        try {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
            
            const gattServer = await device.gatt.connect();
            const deviceState = {
                id: deviceId,
                device,
                gattServer,
                services: [],
                connected: true,
                lastActivity: Date.now(),
                quality: 'unknown'
            };
            
            this.devices.set(deviceId, deviceState);
            
            this.emit('deviceReconnected', { deviceId, deviceState });
            
            this.log.info('Auto-reconnect successful', { deviceId });
            
        } catch (error) {
            this.log.error('Auto-reconnect failed', { 
                deviceId, 
                error: error.message 
            });
            
            this.emit('reconnectionFailed', { deviceId, error });
        }
    }

    /**
     * Create connection batches for load balancing
     * @param {Array} deviceConfigs - Device configurations
     * @param {number} batchSize - Batch size
     * @returns {Array} Array of connection batches
     * @private
     */
    _createConnectionBatches(deviceConfigs, batchSize) {
        const batches = [];
        for (let i = 0; i < deviceConfigs.length; i += batchSize) {
            batches.push(deviceConfigs.slice(i, i + batchSize));
        }
        return batches;
    }

    /**
     * Update connection statistics
     * @param {boolean} success - Whether connection was successful
     * @param {number} duration - Connection duration in milliseconds
     * @private
     */
    _updateConnectionStats(success, duration = 0) {
        this.connectionStats.totalAttempts++;
        
        if (success) {
            this.connectionStats.successfulConnections++;
            
            // Update average connection time
            const alpha = 0.1;
            this.connectionStats.averageConnectionTime = 
                alpha * duration + (1 - alpha) * this.connectionStats.averageConnectionTime;
        } else {
            this.connectionStats.failedConnections++;
        }
    }

    /**
     * Set up event handlers
     * @private
     */
    _setupEventHandlers() {
        // Handle permission manager events
        this.permissionManager.on('deviceDisconnected', (event) => {
            const deviceId = event.device.id;
            this.disconnectDevice(deviceId);
        });
        
        // Handle global disconnection events
        this.on('deviceDisconnected', (event) => {
            const deviceId = event.deviceId;
            
            // Update device quality
            this.setDeviceQuality(deviceId, 'disconnected');
        });
    }

    /**
     * Sanitize device configuration for logging
     * @param {object} config - Device configuration
     * @returns {object} Sanitized configuration
     * @private
     */
    _sanitizeConfig(config) {
        const sanitized = { ...config };
        
        // Remove potentially sensitive data
        if (sanitized.filters) {
            sanitized.filters = sanitized.filters.map(filter => 
                Object.keys(filter).reduce((acc, key) => {
                    acc[key] = '[FILTER]';
                    return acc;
                }, {})
            );
        }
        
        return sanitized;
    }

    /**
     * Generate unique connection ID
     * @returns {string} Connection identifier
     * @private
     */
    _generateConnectionId() {
        return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

export { DeviceManager };