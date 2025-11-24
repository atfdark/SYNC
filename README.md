# Web Bluetooth Audio Synchronization System

A comprehensive technical implementation for synchronizing audio playback across multiple Bluetooth devices using Web Bluetooth API and advanced timing algorithms.

## 🎯 Overview

This system addresses the complex challenge of playing synchronized audio across multiple Bluetooth devices, handling the inherent latency, drift, and timing variations that occur in wireless audio transmission.

## 🏗️ Architecture Components

### Core System (`src/main.js`)
- **WebBluetoothAudioSync**: Main coordinator that orchestrates all components
- **Event-driven architecture** for loose coupling between components
- **Comprehensive error handling** and recovery mechanisms

### Clock Management (`src/core/clock/`)
- **MasterClock**: Central timing authority with 10ms tick precision
- **DeviceClock**: Individual device timing with drift tracking
- **DriftCorrection**: Automatic compensation for clock synchronization

### Bluetooth Layer (`src/core/bluetooth/`)
- **BluetoothPermissionManager**: Security and permission handling
- **DeviceManager**: Multi-device connection and lifecycle management
- **Web Bluetooth API integration** with fallback strategies

### Audio Synchronization (`src/core/audio/`)
- **AudioSyncEngine**: Master synchronization algorithms
- **BufferManager**: Circular buffer management with drift correction
- **LatencyCompensation**: Network latency measurement and compensation

### Utilities (`src/core/utils/`)
- **EventEmitter**: Event-driven communication system
- **Logger**: Comprehensive logging with multiple levels
- **TimeUtils**: High-precision time operations and conversions

## 🎵 Key Features

### ✅ Multi-Device Synchronization
- Connect up to 8 Bluetooth devices simultaneously
- 1ms synchronization accuracy target
- Automatic drift correction and adjustment
- Load-balanced connection management

### ✅ Advanced Timing Algorithms
- Master clock synchronization with sub-millisecond precision
- Real-time drift detection and correction
- Latency measurement and compensation
- Buffer synchronization across devices

### ✅ Web Bluetooth Integration
- Full HTTPS security compliance
- Browser compatibility handling (Chrome/Edge, Safari)
- Graceful fallback for unsupported browsers
- Automatic reconnection on disconnection

### ✅ Performance Monitoring
- Real-time synchronization quality metrics
- Latency and jitter tracking
- Buffer utilization monitoring
- System performance statistics

## 🚀 Getting Started

### 1. Setup Requirements
- **HTTPS or localhost** (Web Bluetooth requirement)
- **Modern browser** with Web Bluetooth support
- **Bluetooth-enabled devices** (speakers, headphones, etc.)

### 2. Basic Usage

```javascript
import { WebBluetoothAudioSync } from './src/main.js';

// Initialize the system
const audioSync = new WebBluetoothAudioSync({
    syncTolerance: 1,        // 1ms tolerance
    bufferSize: 2048,        // Audio buffer size
    sampleRate: 44100,       // Audio sample rate
    maxDevices: 8           // Maximum devices
});

// Initialize and start system
await audioSync.initialize();
await audioSync.start();

// Connect devices
const deviceConfigs = [
    { name: 'Speaker 1', serviceUuid: '0000110b-0000-1000-8000-00805f9b34fb' },
    { name: 'Speaker 2', serviceUuid: '0000110b-0000-1000-8000-00805f9b34fb' }
];

await audioSync.connectDevices(deviceConfigs);

// Start synchronized playback
const audioData = new ArrayBuffer(/* your audio data */);
const session = await audioSync.startSynchronizedPlayback(audioData);
```

### 3. Browser Compatibility

| Browser | Support | Notes |
|---------|---------|--------|
| **Chrome** | ✅ Full | Recommended browser |
| **Edge** | ✅ Full | Chromium-based |
| **Safari** | ⚠️ Limited | iOS 13+, macOS 14.1+ |
| **Firefox** | ❌ None | Behind experimental flags |

## 📊 Demo Interface

Open `index.html` in a supported browser to access the interactive demo:

- **System Controls**: Initialize, start/stop the synchronization system
- **Device Management**: Connect and manage Bluetooth devices
- **Audio Controls**: Start/stop test playback sessions
- **Real-time Metrics**: Monitor synchronization accuracy and latency
- **System Logs**: View detailed operation logs

## 🔧 Technical Specifications

### Synchronization Performance
- **Target Accuracy**: ±1ms between devices
- **Master Clock Precision**: 10ms tick intervals
- **Drift Correction**: Automatic with 100ms intervals
- **Buffer Size**: 2048 samples (configurable)
- **Maximum Devices**: 8 simultaneous connections

### Audio Processing
- **Sample Rate**: 44.1kHz (configurable)
- **Bit Depth**: 32-bit float internal processing
- **Buffer Management**: Circular buffers with overflow protection
- **Latency Compensation**: Round-trip time measurement and compensation

### Security & Permissions
- **HTTPS Requirement**: Secure context mandatory
- **User Consent**: Explicit permission for each device
- **Permission Flow**: Browser-native dialogs and fallbacks
- **Data Protection**: No persistent audio data storage

## 🧪 Testing & Validation

### Synchronization Testing
```javascript
// Test synchronization accuracy
const quality = audioSync.getSynchronizationQuality();
console.log(`Overall quality: ${quality.overall}`);
console.log(`Average accuracy: ${quality.averageAccuracy}%`);
```

### Performance Monitoring
```javascript
// Get system status
const status = audioSync.getSystemStatus();
console.log(`Active devices: ${status.activeDevices}`);
console.log(`Sync accuracy: ${status.syncAccuracy}%`);
```

## 🛠️ Development

### Project Structure
```
web-bluetooth-audio-sync/
├── src/
│   ├── core/
│   │   ├── bluetooth/       # Bluetooth connectivity
│   │   ├── audio/          # Audio synchronization
│   │   ├── clock/          # Timing management
│   │   └── utils/          # Utility classes
│   ├── ui/                 # User interface components
│   ├── config/             # Configuration files
│   └── main.js            # Main system entry point
├── tests/                 # Test suites
├── docs/                  # Documentation
└── index.html            # Demo interface
```

### Key Classes

- **`WebBluetoothAudioSync`**: Main system coordinator
- **`MasterClock`**: Central timing authority
- **`DeviceManager`**: Multi-device connection management
- **`AudioSyncEngine`**: Synchronization algorithms
- **`BufferManager`**: Audio buffer handling
- **`DriftCorrection`**: Clock drift compensation

## 🔬 Architecture Highlights

### Event-Driven Design
All components communicate through a centralized event system, ensuring loose coupling and extensibility.

### Modular Components
Each component has a single responsibility:
- **Clock Management**: Handles all timing-related operations
- **Bluetooth Layer**: Manages device connectivity and permissions
- **Audio Engine**: Processes synchronization algorithms
- **Buffer Management**: Handles audio data flow

### Error Resilience
- Automatic reconnection on device disconnection
- Graceful degradation when devices become unavailable
- Comprehensive error logging and recovery
- Fallback mechanisms for unsupported browsers

## 🎯 Use Cases

### Multi-Room Audio
Synchronize speakers across different rooms for immersive audio experiences.

### Home Theater Systems
Coordinate multiple audio output devices for consistent sound quality.

### Interactive Installations
Real-time audio synchronization for art installations and experiences.

### Live Performance Audio
Coordinate multiple wireless speakers for live events and performances.

## 📈 Future Enhancements

### Planned Features
- **WebRTC Fallback**: Alternative connection method for unsupported browsers
- **Advanced Audio Processing**: Real-time effects and filtering
- **Mobile App Integration**: Companion apps for device management
- **Cloud Synchronization**: Remote device coordination

### Performance Optimizations
- **WebAssembly Integration**: Audio processing acceleration
- **Web Workers**: Background processing for large audio files
- **IndexedDB Storage**: Offline capability and settings persistence

## 📄 License

This project is implemented as a technical demonstration and proof-of-concept for Web Bluetooth audio synchronization.

## 🤝 Contributing

This implementation serves as a comprehensive reference for Web Bluetooth audio synchronization. The modular architecture allows for easy extension and customization for specific use cases.

## 📞 Support

For technical questions about the implementation:
- Review the comprehensive architectural documentation in `architecture.md`
- Examine the demo interface in `index.html` for practical usage examples
- Study the individual component implementations for detailed algorithm understanding

---

**Note**: This is a technical implementation demonstration. For production use, additional testing, optimization, and security measures should be implemented based on specific requirements.