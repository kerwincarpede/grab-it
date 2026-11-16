# Text recognition models

Grab-it reads the text in captures with [ocrs](https://github.com/robertknight/ocrs)
and ships its two pre-trained models in this folder:

| File | SHA-256 |
| --- | --- |
| `text-detection.onnx` | `a917b23dbd9524b465df7e922641b3ff2981623df4ded5a0234004ef2fee7cfe` |
| `text-recognition.onnx` | `86c145c2edb96c8caed5b1ebb8f44d706408922211451c309c625157dd6061c5` |

Ocrs models (https://github.com/robertknight/ocrs-models), trained on the
HierText dataset by Google Research. Licensed under CC BY-SA 4.0.

- Licence: Creative Commons Attribution-ShareAlike 4.0 International,
  https://creativecommons.org/licenses/by-sa/4.0/
- Models and their licence: https://github.com/robertknight/ocrs-models
  (see its `LICENSE.md`)
- Dataset: https://github.com/google-research-datasets/hiertext

The files are unmodified copies of the ones the ocrs project publishes at
`https://ocrs-models.s3-accelerate.amazonaws.com/<file>`. This licence covers
the two model files only; the rest of Grab-it is under its own licence.
