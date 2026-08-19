#!/usr/bin/env python3
"""
segment-frame.py — cut the background out of ONE still frame, at full size.

The thumbnail's face column is 461x720 on a 1280x720 canvas, so unlike the PIP
bubble (segment-take.py, deliberately 640x360) this matte is produced at the
frame's native resolution: the cutout IS the picture here, not a corner
garnish, and 640-wide alpha edges upscaled 2x read as exactly the pasted-on
sticker the PIP gate exists to reject.

Reads a PNG/JPEG, writes an RGBA PNG whose alpha channel is the person, and
prints one line of JSON metrics (coverage, holeRatio) for the Node side to
gate on — the same "refuse a bad matte" discipline as the PIP. Every failure
exits non-zero with a message on stderr; it never writes a half-finished file
and reports success.
"""

import argparse
import json
import os
import sys

import numpy as np


def hole_ratio(person, cv2):
    """Holes through the silhouette — a shirt lost against the wall."""
    filled = person.copy()
    contours, _ = cv2.findContours(person, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(filled, contours, -1, 1, thickness=cv2.FILLED)
    person_px = int(person.sum())
    if person_px == 0:
        return 0.0
    return float((filled.astype(np.int32) - person.astype(np.int32)).clip(min=0).sum()) / person_px


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--model", required=True)
    args = ap.parse_args()

    for path, what in ((args.input, "input"), (args.model, "model")):
        if not os.path.exists(path):
            print(f"{what} not found: {path}", file=sys.stderr)
            return 2

    try:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks.python import vision, BaseOptions
    except ImportError as e:
        print(f"segmentation dependencies missing: {e}", file=sys.stderr)
        return 3

    frame = cv2.imread(args.input, cv2.IMREAD_COLOR)
    if frame is None:
        print(f"could not read image {args.input}", file=sys.stderr)
        return 4

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    segmenter = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
        base_options=BaseOptions(model_asset_path=args.model),
        output_category_mask=True,
        running_mode=vision.RunningMode.IMAGE,
    ))
    try:
        res = segmenter.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb)))
    finally:
        segmenter.close()

    mask = res.category_mask.numpy_view()
    # The selfie model emits 0 for the person and 255 for background — and its
    # working resolution is its own; the mask comes back at the input size.
    person = (mask == 0).astype(np.uint8)

    # A light blur on the alpha softens the stair-stepping that makes a cutout
    # read as pasted on. Kernel scaled with the frame so a 4K input gets the
    # same relative softness as the PIP's 5px-at-640.
    k = max(3, (frame.shape[1] // 128) | 1)
    alpha = cv2.GaussianBlur(person * 255, (k, k), 0)

    rgba = np.dstack([rgb, alpha]).astype(np.uint8)
    ok = cv2.imwrite(args.output, cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    if not ok:
        print(f"could not write {args.output}", file=sys.stderr)
        return 5

    print(json.dumps({
        "width": int(frame.shape[1]),
        "height": int(frame.shape[0]),
        "coverage": round(float(person.mean()), 4),
        "holeRatio": round(hole_ratio(person, cv2), 4),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
