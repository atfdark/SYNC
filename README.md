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
- **SystemAudioCapture**: System audio capture for dual output (laptop + devices)

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

### ✅ System Audio Capture & Dual Output
- Capture audio from any application playing on the laptop (Spotify, YouTube, etc.)
- Simultaneous playback through laptop speakers AND connected Bluetooth devices
- Real-time audio level monitoring
- Compatible with Chromium-based browsers (Chrome, Edge) over HTTPS

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
- **Node.js** (for WebSocket signaling server)

### 2. WebSocket Signaling Server Setup

The system now uses a dedicated WebSocket signaling server for cross-device WebRTC connections. This replaces the previous BroadcastChannel limitation.

#### Install Dependencies
```bash
npm install
```

#### Start the Signaling Server
```bash
node server/server.js
```

The server will start on `http://localhost:3001` and provide:
- WebSocket signaling for WebRTC connections
- Room-based device coordination
- Health check endpoint at `/health`
- Room information at `/room/:roomId`

#### Server Features
- **Cross-device signaling**: Connect mobile devices from different browsers/networks
- **Room management**: Multiple independent sync sessions
- **Real-time communication**: Low-latency signaling for WebRTC
- **Health monitoring**: Server status and connection statistics

### 3. Basic Usage

**Note**: Make sure the WebSocket signaling server is running (`node server/server.js`) before using the system.

```javascript
import { WebBluetoothAudioSync } from './src/main.js';

// Initialize the system with WebSocket signaling
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

// Start synchronized playback with audio files
const audioData = new ArrayBuffer(/* your audio data */);
const session = await audioSync.startSynchronizedPlayback(audioData);

// OR: Enable dual output to capture system audio (Spotify, etc.)
await audioSync.enableDualOutput(true);
await audioSync.requestSystemAudioPermission();
await audioSync.startSystemAudioCapture();
```

### 3. Browser Compatibility

| Browser | Support | Notes |
|---------|---------|--------|
| **Chrome** | ✅ Full | Recommended browser |
| **Edge** | ✅ Full | Chromium-based |
| **Safari** | ⚠️ Limited | iOS 13+, macOS 14.1+ |
| **Firefox** | ❌ None | Behind experimental flags |

## 📊 Demo Interface

**Prerequisites**: Start the WebSocket signaling server first:
```bash
node server/server.js
```

Then open `index.html` in a supported browser to access the interactive demo:

- **System Controls**: Initialize, start/stop the synchronization system
- **Device Management**: Connect and manage Bluetooth devices
- **Mobile Connectivity**: Connect tablets/phones as additional speakers via WebRTC
- **System Audio Capture**: Enable dual output to play any system audio through both laptop speakers and connected devices
- **Audio Controls**: Start/stop test playback sessions
- **Real-time Metrics**: Monitor synchronization accuracy and latency
- **System Logs**: View detailed operation logs

## 🎧 System Audio Capture (NEW!)

### What it does
This feature allows you to capture audio from ANY application playing on your laptop (Spotify, YouTube, Netflix, games, etc.) and play it simultaneously through:
1. **Your laptop's built-in speakers**
2. **All connected Bluetooth devices** (speakers, headphones, etc.)

### How to use
1. **Open the demo interface** in Chrome or Edge (over HTTPS)
2. **Connect your Bluetooth devices** using "Scan & Connect"
3. **Enable "Dual Output Mode"** using the toggle switch
4. **Click "Start System Audio Capture"** and grant permission when prompted
5. **Play any audio** on your laptop - it will come out of ALL speakers simultaneously!

### Requirements
- **Chromium-based browser** (Chrome, Edge) - Firefox and Safari don't support system audio capture
- **HTTPS connection** - Required for getDisplayMedia API
- **User permission** - Browser will ask for screen/audio capture permission
- **Active audio playback** - Any sound playing on the system will be captured and synchronized

### Perfect for
- **Music streaming** through Spotify/Apple Music while using Bluetooth speakers
- **Movie watching** with both laptop speakers and external audio system
- **Gaming audio** with synchronized multi-speaker setup
- **Video calls** heard through both laptop and conference room speakers

## 🚀 Vercel Deployment

### Overview

This project is configured for easy deployment to Vercel, providing automatic HTTPS support which is required for Web Bluetooth API functionality. The deployment supports both automatic GitHub integration and manual deployment methods.

### Prerequisites

- **Vercel Account**: Sign up at [vercel.com](https://vercel.com)
- **GitHub Repository** (for automatic deployment): Push your code to GitHub
- **Vercel CLI** (for manual deployment): `npm install -g vercel`

### Deployment Methods

#### Method 1: Automatic GitHub Integration (Recommended)

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Add Vercel deployment configuration"
   git push origin main
   ```

2. **Connect to Vercel**
   - Go to [Vercel Dashboard](https://vercel.com/dashboard)
   - Click "New Project"
   - Import your GitHub repository
   - Vercel will automatically detect the configuration from `vercel.json`

3. **Deploy**
   - Click "Deploy"
   - Your site will be available at `https://your-project-name.vercel.app`
   - Vercel provides automatic HTTPS certificates

#### Method 2: Manual CLI Deployment

1. **Install Vercel CLI**
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel**
   ```bash
   vercel login
   ```

3. **Deploy**
   ```bash
   vercel
   ```

4. **Follow Prompts**
   - Set up and deploy: `Yes`
   - Which scope: Select your account
   - Link to existing project: `No`
   - Project name: `web-bluetooth-audio-sync` (or custom)
   - In which directory: `./` (root directory)

5. **Production Deployment**
   ```bash
   vercel --prod
   ```

### Local Development with Vercel

Run the project locally with Vercel's development server:

```bash
# Install dependencies
npm install

# Start development server
npm run dev
# or
vercel dev

# Visit http://localhost:3000
```

### Vercel Configuration Details

The project includes `vercel.json` with optimal configuration:

- **Static Site Hosting**: Uses `@vercel/static` builder
- **Security Headers**: Includes CSP, Permissions-Policy for Web Bluetooth
- **Asset Caching**: Long-term caching for static assets
- **HTTPS Enforcement**: Required for Web Bluetooth API
- **Single Page Application**: Proper routing configuration

### Environment Configuration

No special environment variables are required for this static site. The Web Bluetooth API requires HTTPS, which Vercel provides automatically.

### Browser Compatibility on Vercel

| Browser | Support | Notes |
|---------|---------|--------|
| **Chrome** | ✅ Full | Recommended browser |
| **Edge** | ✅ Full | Chromium-based |
| **Safari** | ⚠️ Limited | iOS 13+, macOS 14.1+ |
| **Firefox** | ❌ None | Behind experimental flags |

### HTTPS and Web Bluetooth

- **Automatic HTTPS**: Vercel provides free SSL certificates
- **Web Bluetooth Requirement**: HTTPS is mandatory for Web Bluetooth API
- **Security Headers**: Configured for Web Bluetooth permissions
- **Content Security Policy**: Allows necessary permissions for audio/Bluetooth

### Deployment Benefits

- **Global CDN**: Fast loading worldwide
- **Automatic HTTPS**: Secure connections required for Web Bluetooth
- **Git Integration**: Automatic deployments on code changes
- **Custom Domains**: Option to use your own domain
- **Analytics**: Built-in performance monitoring

### Troubleshooting

1. **Web Bluetooth Not Working**
   - Ensure you're using HTTPS (provided by Vercel)
   - Check browser compatibility
   - Grant Bluetooth permissions when prompted

2. **Deployment Issues**
   - Verify `vercel.json` configuration
   - Check that all required files are committed
   - Review Vercel build logs

3. **Local Development Issues**
   - Clear browser cache
   - Use Chrome DevTools to check for errors
   - Ensure Bluetooth device permissions are granted

For more details on Vercel deployment, visit the [Vercel documentation](https://vercel.com/docs).

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
- **`SystemAudioCapture`**: System audio capture for dual output
- **`LatencyCompensation`**: Network latency measurement and compensation

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