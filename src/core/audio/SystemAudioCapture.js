import { EventEmitter } from '../utils/EventEmitter.js';
import { logger } from '../utils/Logger.js';

/**
 * SystemAudioCapture handles capturing audio from the system's audio output
 * This allows capturing audio from any application playing on the system
 */
class SystemAudioCapture extends EventEmitter {
    constructor(options = {}) {
        super();
        
        // Configuration
        this.sampleRate = options.sampleRate || 44100;
        this.bufferSize = options.bufferSize || 2048;
        this.monitorVolume = options.monitorVolume !== false; // Keep system audio playing through speakers
        
        // Audio context and nodes
        this.audioContext = null;
        this.mediaStreamSource = null;
        this.analyser = null;
        this.gainNode = null;
        this.scriptProcessor = null;
        
        // Capture state
        this.isCapturing = false;
        this.capturedStream = null;
        this.audioBuffer = [];
        this.isSupported = false;
        
        // Performance tracking
        this.captureStats = {
            startTime: null,
            totalCaptured: 0,
            bufferOverflows: 0,
            averageLatency: 0
        };
        
        this.log = logger.createScopedLogger('SystemAudioCapture');

        // Initialize audio context asynchronously
        this._initializeAudioContext().catch(error => {
            this.log.error('Failed to initialize System AudioContext in constructor', { error: error.message });
        });
    }

    /**
     * Initialize audio context and check for support
     * @private
     */
    async _initializeAudioContext() {
        try {
            this.log.debug('Attempting to initialize System AudioContext', {
                hasAudioContext: !!window.AudioContext,
                hasWebkitAudioContext: !!window.webkitAudioContext,
                userAgent: navigator.userAgent
            });
            // Check for getDisplayMedia support (for system audio capture)
            this.isSupported = navigator.mediaDevices &&
                              navigator.mediaDevices.getDisplayMedia &&
                              window.AudioContext;

            if (this.isSupported) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;

                if (!AudioContextClass) {
                    throw new Error('AudioContext not available in this browser');
                }

                this.log.debug('Creating AudioContext', {
                    AudioContextClass: AudioContextClass.name,
                    sampleRate: this.sampleRate
                });

                try {
                    this.audioContext = new AudioContextClass({
                        sampleRate: this.sampleRate
                    });
                    this.log.debug('AudioContext created successfully', {
                        state: this.audioContext.state,
                        sampleRate: this.audioContext.sampleRate
                    });
                } catch (error) {
                    this.log.error('Failed to create AudioContext', {
                        error: error.message,
                        AudioContextClass: AudioContextClass.name
                    });
                    throw error;
                }

                // Resume AudioContext if it's suspended (required in modern browsers)
                if (this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }

                this.log.info('System audio capture initialized', {
                    sampleRate: this.sampleRate,
                    supported: true,
                    audioContextState: this.audioContext.state,
                    actualSampleRate: this.audioContext.sampleRate
                });
            } else {
                this.log.warn('System audio capture not supported', {
                    getDisplayMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
                    audioContext: !!(window.AudioContext || window.webkitAudioContext)
                });
            }

        } catch (error) {
            this.log.error('Failed to initialize audio context', {
                error: error.message,
                errorName: error.name,
                stack: error.stack
            });
            this.isSupported = false;
        }
    }

    /**
     * Check if system audio capture is supported
     * @returns {boolean} True if supported
     */
    isSupported() {
        return this.isSupported;
    }

    /**
     * Request permission to capture system audio
     * @returns {Promise<boolean>} True if permission granted
     */
    async requestPermission() {
        if (!this.isSupported) {
            throw new Error('System audio capture not supported on this browser');
        }

        try {
            this.log.info('Requesting system audio capture permission');
            
            // Request screen capture with audio
            this.capturedStream = await navigator.mediaDevices.getDisplayMedia({
                video: false, // We only need audio
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: this.sampleRate
                }
            });
            
            // Verify audio track exists
            const audioTrack = this.capturedStream.getAudioTracks()[0];
            if (!audioTrack) {
                throw new Error('No audio track found in captured stream');
            }
            
            this.log.info('System audio capture permission granted');
            this.emit('permissionGranted');
            
            return true;
            
        } catch (error) {
            this.log.error('System audio capture permission denied', { error: error.message });
            this.emit('permissionDenied', { error });
            throw error;
        }
    }

    /**
     * Start capturing system audio
     * @returns {Promise<void>}
     */
    async startCapture() {
        if (!this.isCapturing && this.capturedStream) {
            try {
                this.log.info('Starting system audio capture');
                
                // Create audio nodes
                this._createAudioNodes();
                
                // Connect the stream to audio processing
                this.mediaStreamSource.connect(this.analyser);
                this.mediaStreamSource.connect(this.gainNode);
                this.mediaStreamSource.connect(this.scriptProcessor);
                
                // Set up script processor for real-time audio data
                this.scriptProcessor.onaudioprocess = (event) => {
                    this._processAudioData(event);
                };
                
                this.isCapturing = true;
                this.captureStats.startTime = Date.now();
                
                this.emit('captureStarted');
                
                this.log.info('System audio capture started successfully');
                
            } catch (error) {
                this.log.error('Failed to start audio capture', { error: error.message });
                throw error;
            }
        }
    }

    /**
     * Stop capturing system audio
     */
    stopCapture() {
        if (this.isCapturing) {
            this.log.info('Stopping system audio capture');
            
            // Stop all audio nodes
            if (this.scriptProcessor) {
                this.scriptProcessor.disconnect();
                this.scriptProcessor.onaudioprocess = null;
            }
            
            if (this.mediaStreamSource) {
                this.mediaStreamSource.disconnect();
            }
            
            if (this.analyser) {
                this.analyser.disconnect();
            }
            
            if (this.gainNode) {
                this.gainNode.disconnect();
            }
            
            // Stop captured stream
            if (this.capturedStream) {
                this.capturedStream.getTracks().forEach(track => track.stop());
                this.capturedStream = null;
            }
            
            // Reset nodes
            this.mediaStreamSource = null;
            this.analyser = null;
            this.gainNode = null;
            this.scriptProcessor = null;
            
            // Reset capture state
            this.isCapturing = false;
            this.captureStats.totalCaptured = 0;
            
            this.emit('captureStopped');
            
            this.log.info('System audio capture stopped');
        }
    }

    /**
     * Create audio processing nodes
     * @private
     */
    _createAudioNodes() {
        // Create source from captured stream
        this.mediaStreamSource = this.audioContext.createMediaStreamSource(this.capturedStream);
        
        // Create analyser for audio analysis
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = this.bufferSize;
        this.analyser.smoothingTimeConstant = 0.8;
        
        // Create gain node for volume control
        this.gainNode = this.audioContext.createGain();
        
        // Create script processor for real-time audio processing
        this.scriptProcessor = this.audioContext.createScriptProcessor(this.bufferSize, 1, 1);
    }

    /**
     * Process captured audio data
     * @param {AudioProcessingEvent} event - Audio processing event
     * @private
     */
    _processAudioData(event) {
        if (!this.isCapturing) return;
        
        try {
            const inputBuffer = event.inputBuffer;
            const outputBuffer = event.outputBuffer;
            
            // Get input audio data
            const inputData = inputBuffer.getChannelData(0);
            const outputData = outputBuffer.getChannelData(0);
            
            // Copy input to output (pass-through for monitoring)
            outputData.set(inputData);
            
            // Process audio data
            this._processAudioFrame(inputData);
            
            // Update statistics
            this.captureStats.totalCaptured += inputData.length;
            
        } catch (error) {
            this.log.error('Audio processing error', { error: error.message });
            this.emit('processingError', { error });
        }
    }

    /**
     * Process individual audio frame
     * @param {Float32Array} audioData - Audio frame data
     * @private
     */
    _processAudioFrame(audioData) {
        // Create a copy of the audio data for processing
        const processedData = new Float32Array(audioData);
        
        // Store in buffer for synchronization
        this.audioBuffer.push({
            data: processedData,
            timestamp: performance.now(),
            sampleRate: this.sampleRate
        });
        
        // Maintain buffer size
        if (this.audioBuffer.length > 100) { // Keep last 100 frames
            this.audioBuffer.shift();
        }
        
        // Emit audio data event for consumption by sync engine
        this.emit('audioFrame', {
            data: processedData,
            timestamp: performance.now(),
            sampleRate: this.sampleRate
        });
    }

    /**
     * Get the latest audio frame
     * @returns {object|null} Latest audio frame or null
     */
    getLatestFrame() {
        return this.audioBuffer.length > 0 ? this.audioBuffer[this.audioBuffer.length - 1] : null;
    }

    /**
     * Get audio buffer status
     * @returns {object} Buffer status
     */
    getBufferStatus() {
        return {
            isCapturing: this.isCapturing,
            bufferSize: this.audioBuffer.length,
            totalCaptured: this.captureStats.totalCaptured,
            uptime: this.captureStats.startTime ? Date.now() - this.captureStats.startTime : 0,
            isSupported: this.isSupported
        };
    }

    /**
     * Get capture statistics
     * @returns {object} Capture statistics
     */
    getStats() {
        return {
            ...this.captureStats,
            isCapturing: this.isCapturing,
            isSupported: this.isSupported,
            bufferSize: this.audioBuffer.length
        };
    }

    /**
     * Set monitor volume (volume of system audio through speakers)
     * @param {number} volume - Volume level (0-1)
     */
    setMonitorVolume(volume) {
        if (this.gainNode) {
            this.gainNode.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), this.audioContext.currentTime);
            this.log.debug('Monitor volume set', { volume });
        }
    }

    /**
     * Clean up resources
     */
    cleanup() {
        this.stopCapture();
        
        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
        }
        
        this.audioBuffer = [];
        
        this.log.info('System audio capture cleaned up');
        this.emit('cleaned');
    }

    /**
     * Check if currently capturing
     * @returns {boolean} True if capturing
     */
    getIsCapturing() {
        return this.isCapturing;
    }

    /**
     * Get audio level for visualization
     * @returns {number} Audio level (0-1)
     */
    getAudioLevel() {
        if (!this.analyser || !this.isCapturing) return 0;
        
        const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(dataArray);
        
        // Calculate average level
        const sum = dataArray.reduce((acc, value) => acc + value, 0);
        return sum / dataArray.length / 255; // Normalize to 0-1
    }
}

export { SystemAudioCapture };