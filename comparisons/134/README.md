# Grab-it microphone denoiser listening comparison

Unzip the pack and open index.html locally. Play a six-second clip and switch among Original, FFmpeg, RNNoise and DeepFilterNet3. Download listening notes before closing the page. Try the clean and quiet cases for syllable loss, the keyboard case for residual clicks and the echo/competing-reader cases as stress tests. Intelligibility, naturalness, remaining noise and artifacts await listener scoring.

## Inputs and permissions

LibriSpeech ASR corpus © 2014 Vassil Panayotov, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source: [OpenSLR 12](https://www.openslr.org/12/), test-clean.tar.gz, MD5 32fa31d27d2e1cad72775fee3f4849a9. Volunteers read these recordings for [LibriVox](https://librivox.org/pages/public-domain/). Attribution and the original corpus licence accompany this pack. Four readers contributed the selected excerpts, identified by exact source paths in sources.json. These derivatives are distributed under CC BY 4.0.

The source audio was resampled from 16 kHz to 48 kHz mono, cut to six seconds and gain-adjusted. Fan/hum, key taps and intermittent noise are controlled synthetic overlays. Echo uses two delayed copies, competing conversation uses a second reader and quiet speech uses attenuation. These cases test reproducible conditions. The source metadata does not quantify the four microphones or replicate a live room. The fan case also has an independent, synthetic system-audio track.

## Linux benchmark

AMD Ryzen 5 5600G, 12 logical CPUs. CPU processing, no GPU. Single-process elapsed time including startup and file I/O, one run per case, six seconds of audio. Per-case times and peak process RSS are in measurements.csv. CI load can affect these measurements.

|Engine and settings|Real-time factor range|Peak RSS across seven runs|Additional local assets and first setup|
|---|---:|---:|---|
|FFmpeg 8.0.1 highpass at 80 Hz and afftdn nf=-25, tracking enabled|0.0083–0.0100|38,988 KiB|System FFmpeg already installed. No model. Ubuntu ffmpeg package 2,031,748 bytes downloaded and 2,788 KiB installed excluding shared dependencies. This build enables GPL; see the Ubuntu copyright manifest included here.|
|Same FFmpeg, arnndn with beguiling-drafter bd.rnnn|0.0133|39,364 KiB|Download one 299,693-byte weight file. Same runtime as baseline.|
|DeepFilterNet3 ONNX, deep-filter v0.5.6 x86_64 musl, -D|0.1433–0.1583|44,236 KiB|Download executable (36,417,296 bytes) and explicit model archive (7,983,136 bytes), 44,400,432 total installed file bytes. No Python or GPU runtime for inference.|

FFmpeg build provenance and licence configuration are in ffmpeg-version.txt. RNNoise model provenance is [rnnoise-models](https://github.com/GregorR/rnnoise-models/tree/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d), whose author states the weight files are outside copyright. DeepFilterNet [release](https://github.com/Rikorose/DeepFilterNet/releases/tag/v0.5.6) and [code licensing](https://github.com/Rikorose/DeepFilterNet/tree/v0.5.6#license) identify the Linux binary and MIT/Apache-2.0 code licence. The code licence text expressly covers code. The [upstream licence clarification](https://github.com/Rikorose/DeepFilterNet/tree/7b14b895fe7fc42cab72b4a4c1e49c982bd6404b#license) expressly covers the code and model weights under MIT or Apache-2.0. The ONNX archive at that revision has the same SHA-256 as the tested archive. The pack contains processed samples, excluding inference binaries and weights. Distribution in a production installer requires a separate artifact and licence decision for each platform.

## Reproduce

Place this directory under a working directory as pack/. Create sibling sources/ and tools/ directories, obtain the following upstream files, and verify their recorded digests. Install FFmpeg 8.0.1, GNU time, Python 3.14, numpy 2.5.5 and scipy 1.18.1. Run python pack/prepare.py. Assets downloaded to reproduce this evaluation are separate from product installation size.

- sources/test-clean.tar.gz from https://www.openslr.org/resources/12/test-clean.tar.gz
- tools/bd.rnnn from https://raw.githubusercontent.com/GregorR/rnnoise-models/3eee541a283fd3b8f81b85b1748e3b9ccbefa04d/beguiling-drafter-2018-08-30/bd.rnnn
- tools/DeepFilterNet3_onnx.tar.gz from https://raw.githubusercontent.com/Rikorose/DeepFilterNet/v0.5.6/models/DeepFilterNet3_onnx.tar.gz
- tools/deep-filter-0.5.6-x86_64-unknown-linux-musl from https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl. Make executable before use.

Each processor reads the same Original.wav independently. Raw output includes engine delay and FFmpeg flush padding. The listening files compensate the measured waveform lag and retain exactly 288,000 samples. FFmpeg lag is approximately 25 ms, RNNoise 10 ms, DeepFilterNet3 with -D zero. Matching scales each processed file to the input RMS over clean-reference speech-active samples, with common headroom across choices if necessary. The CSV records the gain applied to each processor output. The generated fan-hum stems retain the same system samples in channel 2 across all variants. The mixed MP4 has a 30 fps test pattern and AAC audio. ffprobe reports both streams start at zero and last six seconds.

Regenerate the mixed timing example with:
```sh
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=30:duration=6 -i pack/fan-hum/DeepFilterNet3-mix.wav -c:v libx264 -preset ultrafast -c:a aac -movflags +faststart pack/fan-hum-mixed-example.mp4
```
