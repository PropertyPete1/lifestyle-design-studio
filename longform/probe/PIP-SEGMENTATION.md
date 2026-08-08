# Background removal for the floating-head PIP — the choice, and why

Measured 2026-08-08 on this machine (Apple M1, 8 cores). Written before the
compositing code, same as the map licensing conclusion.

**Conclusion: MediaPipe `ImageSegmenter` with the `selfie_segmenter` model, run
at 640x360, mask upscaled to bubble size.** ~8 ms/frame here, ~1 minute of
inference per 4 minutes of on-camera footage. rembg/u2net is rejected on cost
by roughly two orders of magnitude, for quality nobody will see at 25% of frame
height.

---

## What the bubble actually needs

The PIP is **22-28% of frame height** — about 260-300px tall on a 1080p canvas.
That single number decides the whole evaluation, and getting it wrong is how
this feature ends up costing an hour of runner time for nothing.

A matte that will be displayed 300px tall does not need to be computed at
1920x1080. The model resizes its input to 256x256 internally regardless, so
feeding it a 1080p frame buys nothing but the cost of moving the pixels. What
matters is that the mask is clean at the size it is *shown*.

## The measurements

Same model, same machine, varying only the frame size handed in:

| input | ms/frame | inference for 4 min of on-camera |
| --- | --- | --- |
| 1920x1080 | 26.1 | 3.1 min |
| 1280x720 | 18.4 | 2.2 min |
| **640x360** | **8.2** | **1.0 min** |
| 512x288 | 5.8 | 0.7 min |
| 256x144 | 4.4 | 0.5 min |

The curve flattens below 640x360 because the model's own 256x256 resize
dominates — going smaller stops buying speed and starts costing edge quality on
hair, which is the first thing that looks wrong in a cutout.

**640x360 is the knee.** It is 3x cheaper than 1080p, and its mask upscaled to a
300px bubble is sampled *down*, not up, so nothing is invented.

### These are M1 numbers, and the runner is not an M1

The GitHub Actions runner is CPU-only x86. Expect 2-4x slower — call it 2-4
minutes of inference per 4 minutes of on-camera footage. Against the assembly
probe's measured 18 minutes of wall for a 12-minute 1080p render, and a 6-hour
job ceiling, that is affordable. It is not affordable at 1080p on a bad day,
which is the other reason for 640x360.

The runner figure is an estimate. It has not been measured, and it is the one
number here I would not put in a commit message as fact.

## Why not rembg / u2net

u2net produces a visibly better matte — cleaner hair, fewer holes in
low-contrast clothing. It also runs on the order of **1-2 seconds per frame** on
CPU. For 4 minutes of on-camera footage that is 7,200 frames, or **2-4 hours**
of inference for one video. That does not fit the job budget, and it buys detail
that is discarded when the result is scaled to 300px tall and composited over a
map.

If the bubble were ever full-screen, this trade would flip.

## Why not the API everyone's tutorial uses

`mp.solutions.selfie_segmentation` — the interface in essentially every guide
and StackOverflow answer — **does not exist in MediaPipe 1.0**. The legacy
`solutions` namespace is gone entirely; only the Tasks API remains:

```
mediapipe 1.0.0
top-level: ['Image', 'ImageFormat', 'tasks']
AttributeError: module 'mediapipe' has no attribute 'solutions'
```

Code copied from a tutorial will import cleanly and fail at first use. The Tasks
API also requires an explicit model file, which the legacy API bundled — so
`selfie_segmenter.tflite` (244 KB, from Google's official model host) has to be
fetched and pinned rather than assumed.

## What this adds to the runner

- A Python 3 virtualenv with `mediapipe` and `opencv-python-headless`.
- One 244 KB model file.

That is a real new dependency for a Node pipeline, and it is the strongest
argument *against* the feature rather than for it. It is justified only because
the alternative — Peter on screen for 30% of a twelve-minute video and absent
for the rest — is a retention problem worth spending a dependency on.

## The quality gate matters more than the model

Any segmentation fails somewhere: a hand crossing the face, a busy background,
motion blur on a turn. The gate scores each cutout and **rejects the PIP rather
than shipping a bad matte**, falling back to the visual alone. The rules are in
`yt-pip.js`; the short version is that a mask which is mostly empty, mostly
full, or riddled with holes is not a person, and a video with no floating head
is much better than a video with a floating head that has no hair.

## Sources

- MediaPipe Image Segmenter — https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter
- Model: `selfie_segmenter.tflite`, float16 — https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite
