# Noise removal model

Grab-it removes background noise from a recording's microphone with
ffmpeg's `arnndn` filter (RNNoise) and the beguiling-drafter model from
[GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models), and
ships it in this folder:

| File | SHA-256 |
| --- | --- |
| `bd.rnnn` | `ae3f7411e1e6a884f839a4a145c394408398f09854dbc1216ee02faafc98a17b` |

The file is `beguiling-drafter-2018-08-30/bd.rnnn` from that repository at
commit `3eee541a283fd3b8f81b85b1748e3b9ccbefa04d`, unchanged.

The repository's README says of its models: "With the exception of the
tools/ directory and this file, none of this work is creative and thus none
of it is subject to copyright." The model is therefore shipped without a
licence of its own; the rest of Grab-it is under its own licence.
