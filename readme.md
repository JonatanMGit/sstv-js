# SSTV Encoder/Decoder

A TypeScript library for encoding and decoding Slow Scan Television (SSTV) images. Supports multiple SSTV modes for amateur radio and image transmission.

## Supported Modes

- Martin M1
- Martin M2
- Scottie S1
- Scottie S2
- Scottie DX
- Robot 36
- Robot 72
- Robot 8BW
- Wraase SC2-180
- PD50
- PD90
- PD120
- PD160
- PD180
- PD240
- PD290

## Installation

### Prerequisites

- Node.js (v14 or newer recommended)
- npm

### Install dependencies

```
npm install
```

## Usage

### Decoder Example

```js
const { SSTVDecoder, loadWavFile } = require("./src");

// Load WAV audio file
const audio = loadWavFile("input.wav");

// Create decoder
const decoder = new SSTVDecoder(audio.samples, {
  sampleRate: audio.sampleRate,
  enableSlantCorrection: true,
});

decoder.on("modeDetected", (mode) => {
  console.log(`Detected mode: ${mode.name}`);
});

decoder.on("lineDecoded", (line, data, partialImage) => {
  console.log(`Decoded line ${line + 1}`);
});

(async () => {
  const image = await decoder.decode();
  if (image) {
    // image is an ImageData object
    // Convert to RGB or save as needed
  }
})();
```

### Encoder Example

```js
const { SSTVEncoder } = require("./src");

const encoder = new SSTVEncoder({
  mode: "Martin M1", // or any supported mode name
  width: 320,
  height: 240,
});

// Provide image data (ImageData, Buffer, etc.)
encoder.encode(imageData);
// Output is a Float32Array of audio samples
```

### Streaming Decoder (for SDR applications)

For real-time decoding from continuous audio sources like SDR streams:

```js
const { StreamingDecoder } = require("./dist");

// Create streaming decoder
const decoder = new StreamingDecoder({
  sampleRate: 48000, // Your audio sample rate
  maxBufferSeconds: 10, // Buffer size (default: 10s)
  outputNoise: false, // Output lines even when no sync detected
});

// Listen for events
decoder.on("modeDetected", (event) => {
  console.log(`Mode: ${event.mode.name} (${event.method} detection)`);
});

decoder.on("line", (event) => {
  console.log(`Line ${event.line + 1}/${event.height}`);
  // event.pixels contains RGB data for this line
  // Display or process the line in real-time
});

decoder.on("imageComplete", (event) => {
  console.log(`Complete: ${event.image.width}x${event.image.height}`);
  // event.rgbData contains the full RGB image
  // Save or display the final image
});

// Feed audio chunks as they arrive from SDR
sdrStream.on("data", (samples) => {
  decoder.process(samples);
});

// When stream ends, flush remaining data
const finalImage = decoder.flush();

// Cancel if user closes app
decoder.cancel();
```

### List Supported Modes

```js
const { getSupportedModes } = require("./src");
console.log(getSupportedModes());
```

## References

- [SSTV Handbook](https://www.sstv-handbook.com/)
