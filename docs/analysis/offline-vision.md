# Offline vision evaluation

Can a small local model describe a screenshot and locate a control when Grab-it's bundled OCR has little text to work with?

## Fixtures

Render the following three SVG bodies inside a 640 × 360 SVG root with a white background. Use the same renderer for all three and keep the resulting PNGs and their SHA-256 hashes with the run. Coordinates below are original image pixels.

| Capture | SVG body | Expected caption facts | Target |
| --- | --- | --- | --- |
| Settings | `<text x="20" y="40">Settings</text><rect x="380" y="250" width="200" height="60" fill="lightblue"/><text x="400" y="285">Test connection</text>` | Settings and a connection test | Test button |
| Icon only | `<circle cx="160" cy="180" r="60" fill="navy"/><path d="M145 150 L145 210 L185 180 Z" fill="white"/>` | Circular button and play symbol | Play button |
| Image heavy | `<rect width="640" height="360" fill="skyblue"/><circle cx="520" cy="80" r="40" fill="gold"/><path d="M0 360 L250 90 L480 360 Z" fill="seagreen"/>` | Mountain and sun | Sun |

## Run

Use SmolVLM-500M-Instruct GGUF (Q8_0) with its matching vision projector. Record the repository revision, both filenames, hashes and total downloaded bytes. Record the llama.cpp commit, build flags, OS, CPU, RAM and GPU. Copy the same weights and PNGs to both hosts before disconnecting external networking.

Start llama-server bound to localhost with the model, projector, context 4096 and one slot. Set GPU layers to zero on the physical 8 GB CPU-only host and enable full offload on the accelerated host. Record actual offload from the server log, which needs `-lv 4`: llama-server 1.0.0 at its default verbosity prints no `offloaded N/33 layers` or buffer lines. For each PNG send one image through the local chat completions endpoint at temperature zero with a 128-token output limit. Put the text part first and the image part second in the message content; the order changes the scores (see Quality). To time warm requests honestly, set `"cache_prompt": false` in each request's JSON body; it is a per-request field, not a server flag. Ask “Describe the image in one sentence. Give the centre of the TARGET in pixels from the top left of this 640 by 360 image.” Replace TARGET with the target in the table. Save raw replies.

Time model load to first healthy response, first request and five successive warm requests per fixture. Record median and range of warm wall time, peak resident memory and separate accelerator memory where available. Cancel one additional streaming request after its first token. Time until the slot is idle and confirm a subsequent request completes. Record failures, including swap or process termination.

Import the same PNGs into Grab-it with automatic descriptions off. Record the bundled OCR text, word boxes and extraction time. Award one point per expected caption fact explicitly present in each output (six possible). For placement, use the model point or centre of matching OCR words. Count a hit inside the depicted target, inclusive of its boundary. Record misses and missing predictions separately out of three. Keep OCR and model scores separate.

## Results: accelerated Mac

Measured on 22 November 2026 on a Mac17,8 (Apple M5 Pro, 6 performance cores, 48 GiB, macOS 27.0.1), the available accelerated target. Grab-it's source tree (no installed app) was not used: OCR ran Apple Vision through a small Swift script with the same request settings as `ocr_vision.rs` (`VNRecognizeTextRequest`, accurate level) but without its short-line filter or tiling, which these 640 × 360 images do not need. Network access stayed on, so the offline condition was not tested.

Setup. llama.cpp build 12359 (commit b1b770d90, Homebrew 1.0.0, Metal and Accelerate). Weights from ggml-org/SmolVLM-500M-Instruct-GGUF at revision 72e986006ef53e37cdd3f6d4241c90b0f01df376, driven by a Python script posting to `/v1/chat/completions` with `"cache_prompt": false` in each request body (a per-request field, not a server flag) so warm requests re-evaluate the image, and with the text part before the image part in each message.

| Item | Bytes | SHA-256 |
| --- | --- | --- |
| SmolVLM-500M-Instruct-Q8_0.gguf | 436,806,912 | 9d4612de6a42214499e301494a3ecc2be0abdd9de44e663bda63f1152fad1bf4 |
| mmproj-SmolVLM-500M-Instruct-Q8_0.gguf | 108,783,360 | d1eb8b6b23979205fdf63703ed10f788131a3f812c7b1f72e0119d5d81295150 |

Total download: 545,590,272 bytes (about 520 MiB). Fixture PNGs were rendered with rsvg-convert 2.63.4; SHA-256 settings, icon only and image heavy: 8b2adad68057bdd8c62d51bc84d622dbda32e31ca5b225e26435a0d5c23408c9, 3cbc56301afd7d95f66080c3dcca521f78955b85382cc20954b947a8f9d4f239, 10b2fa62ea0b4554077f68fcbc99ab28a40ecd7324cc46b86aa58918328b3fc2.

| Measure | Full Metal offload (33/33 layers) | CPU only, 0/33 layers (same Mac, not the 8 GB target) |
| --- | --- | --- |
| Load to healthy, cold file cache | 3.4 s | not measured cold |
| Load to healthy, cached | 0.21 s | 0.32 s |
| Warm median (range), settings | 0.078 s (0.078 to 0.081) | 0.23 s (0.22 to 0.232) |
| Warm median (range), icon only | 0.083 s (0.082 to 0.085) | 0.229 s (0.223 to 0.239) |
| Warm median (range), image heavy | 0.252 s (0.249 to 0.257) | 0.548 s (0.541 to 0.553) |
| First request, settings / icon / image | 0.090 / 0.083 / 0.259 s | 0.23 / 0.24 / 0.543 s |
| Peak resident memory | 856 MB | 1,175 MB |
| Cancel after first token to idle slot | 7 ms | 8 ms |
| Next request after cancel | completed, 0.08 s | completed, 0.235 s |

Apple silicon uses unified memory, so resident memory includes the accelerator buffers and no separate accelerator figure exists. The server log shows 319 MiB of language model weights plus 160 MiB KV cache and 21 MiB of projector compute buffer on MTL0. No swap or process termination occurred.

### Quality

All model results use the text part first, then the image. The tie with OCR on caption facts below holds only for that order.

| Capture | Model reply (both runs) | Caption facts | Placement |
| --- | --- | --- | --- |
| Settings | "Settings." | 1 of 2 (no connection test) | No coordinates |
| Icon only | "1." (CPU run: unreadable bytes) | 0 of 2 | No coordinates |
| Image heavy | Describes two green triangles and "the yellow sun ... above the green triangle" | 1 of 2 (sun, no mountain) | No coordinates |

The image-heavy reply differs slightly between the offload and CPU runs and was identical across repeats within each run. Model total: 2 of 6 caption facts, 0 placement hits, 0 misses, 3 missing predictions.

| Capture | Bundled OCR output | Time | Caption facts | Placement |
| --- | --- | --- | --- | --- |
| Settings | "Settings" box (17, 31, 41 × 11); "Test connection" box (397, 277, 81 × 6), centre (438, 280) | 23,305 ms first call (engine warm-up, not a stable figure: it depends on whether Vision is already warm, and a re-run saw 157 ms), then 17 to 20 ms | 2 of 2 | Hit: centre inside the button (380 to 580, 250 to 310) |
| Icon only | No lines | 20 ms | 0 of 2 | Missing |
| Image heavy | No lines | 17 ms | 0 of 2 | Missing |

OCR total: 2 of 6 caption facts, 1 placement hit, 0 misses, 2 missing predictions.

Sensitivity to part order. With the image part first, the same model, build and temperature zero score 0 of 6 caption facts instead of 2 of 6, and warm image-heavy Metal latency rises to about 0.30 s from 0.25 s. Settings replies " 1024.", icon only replies " 10." on Metal or " 1." on CPU, and the image-heavy reply calls the sun "a single yellow circle".

## Coverage and decision

| Hardware | Measurements |
| --- | --- |
| Physical 8 GB CPU only | Not measured: no 8 GB CPU-only machine is available to this run. The CPU-only column above is a lower bound on a fast 6-core Apple CPU with 48 GiB, not a substitute. |
| Accelerated | Measured on the Mac17,8 above (Metal, unified memory, no separate accelerator memory). |

With the text part first, the model scored the same as OCR on caption facts and never produced a usable coordinate, so it added no placement over OCR, and its 545 MB download and about 0.9 to 1.2 GB resident memory buy no measured gain. SmolVLM-500M at this prompt is not shown to help; its latency is not the obstacle. Still defer the ship recommendation: the 8 GB CPU-only target has no measurement, and the quality result comes from three synthetic images and one prompt. Rerun on that host, and consider a larger model or a placement-specific prompt, before deciding on an optional download.
