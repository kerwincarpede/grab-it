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

Start llama-server bound to localhost with the model, projector, context 4096 and one slot. Set GPU layers to zero on the physical 8 GB CPU-only host and enable full offload on the accelerated host. Record actual offload from the server log. For each PNG send one image through the local chat completions endpoint at temperature zero with a 128-token output limit. Ask “Describe the image in one sentence. Give the centre of the TARGET in pixels from the top left of this 640 by 360 image.” Replace TARGET with the target in the table. Save raw replies.

Time model load to first healthy response, first request and five successive warm requests per fixture. Record median and range of warm wall time, peak resident memory and separate accelerator memory where available. Cancel one additional streaming request after its first token. Time until the slot is idle and confirm a subsequent request completes. Record failures, including swap or process termination.

Import the same PNGs into Grab-it with automatic descriptions off. Record the bundled OCR text, word boxes and extraction time. Award one point per expected caption fact explicitly present in each output (six possible). For placement, use the model point or centre of matching OCR words. Count a hit inside the depicted target, inclusive of its boundary. Record misses and missing predictions separately out of three. Keep OCR and model scores separate.

## Coverage and decision

| Hardware | Measurements |
| --- | --- |
| Physical 8 GB CPU only | Pending |
| Accelerated | Pending. The available Mac17,8 reports 48 GiB of memory. |

Neither target has a measured score in this report. Defer the optional download decision until both have download size, memory, latency, cancellation and quality measurements.
