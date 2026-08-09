#!/usr/bin/env python3
"""
segment-take.py — cut the background out of one recorded take.

Reads a video, writes an RGBA .mov whose alpha channel is the person. The Node
side composites that over the visuals; nothing here knows what a PIP is.

WHY 640x360 RATHER THAN THE SOURCE RESOLUTION
The bubble is displayed about 300px tall. The model resizes its input to 256x256
internally regardless, so a 1080p frame costs 3x as much and buys nothing. See
longform/probe/PIP-SEGMENTATION.md for the measurements.

WHY THE TASKS API AND AN EXPLICIT MODEL FILE
mp.solutions.selfie_segmentation — the interface in every tutorial — does not
exist in MediaPipe 1.0. Only mediapipe.tasks remains, and it needs the model
passed in rather than bundled.

Prints one line of JSON to stdout: the quality metrics the Node side gates on.
Every failure exits non-zero with a message on stderr; it never writes a
half-finished file and reports success.
"""

import argparse
import json
import os
import subprocess
import sys

import numpy as np

SEG_WIDTH = 640
SEG_HEIGHT = 360


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--sample-frames", type=int, default=12,
                    help="how many evenly spaced frames to score for quality")
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

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        print(f"could not open {args.input}", file=sys.stderr)
        return 4

    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or SEG_WIDTH
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or SEG_HEIGHT
    src_fps = cap.get(cv2.CAP_PROP_FPS) or args.fps
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    segmenter = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
        base_options=BaseOptions(model_asset_path=args.model),
        output_category_mask=True,
        running_mode=vision.RunningMode.VIDEO,
    ))

    # Piped straight into ffmpeg as raw RGBA rather than written frame by frame:
    # an intermediate PNG sequence for a four-minute take is tens of thousands
    # of files and more disk than the runner has spare.
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{SEG_WIDTH}x{SEG_HEIGHT}",
         "-r", str(src_fps), "-i", "pipe:0",
         # qtrle keeps the alpha channel. yuv420p would silently discard it, and
         # the composite would then show a rectangle instead of a cutout.
         "-c:v", "qtrle", "-pix_fmt", "argb",
         args.output],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )

    sample_every = max(1, total // max(1, args.sample_frames)) if total else 30
    coverages, hole_scores, edge_scores = [], [], []
    frames = 0

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            small = cv2.resize(frame, (SEG_WIDTH, SEG_HEIGHT), interpolation=cv2.INTER_AREA)
            rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
            img = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))

            res = segmenter.segment_for_video(img, int(frames * 1000 / src_fps))
            mask = res.category_mask.numpy_view()
            # The selfie model emits 0 for the person and 255 for background.
            person = (mask == 0).astype(np.uint8)

            # A light blur on the alpha softens the stair-stepping that makes a
            # cutout read as pasted on.
            alpha = cv2.GaussianBlur(person * 255, (5, 5), 0)

            rgba = np.dstack([rgb, alpha]).astype(np.uint8)
            ff.stdin.write(rgba.tobytes())

            if frames % sample_every == 0:
                coverages.append(float(person.mean()))
                hole_scores.append(hole_ratio(person, cv2))
                edge_scores.append(edge_roughness(person, cv2))
            frames += 1
    except BrokenPipeError:
        # Surface ffmpeg's OWN stderr — "the pipe closed" names the symptom,
        # and the cause (a missing directory, a bad codec) is in ffmpeg's log.
        detail = ff.stderr.read().decode("utf-8", "replace")[-300:] if ff.stderr else ""
        print(f"ffmpeg closed the pipe early: {detail}", file=sys.stderr)
        return 5
    finally:
        cap.release()
        segmenter.close()
        if ff.stdin:
            ff.stdin.close()
        ff.wait()

    if ff.returncode != 0:
        print(f"ffmpeg failed: {ff.stderr.read().decode('utf-8', 'replace')[-400:]}", file=sys.stderr)
        return 6
    if frames == 0:
        print("no frames were read", file=sys.stderr)
        return 7

    print(json.dumps({
        "frames": frames,
        "sourceWidth": src_w,
        "sourceHeight": src_h,
        "fps": src_fps,
        "segWidth": SEG_WIDTH,
        "segHeight": SEG_HEIGHT,
        # Medians, not means: one bad frame where he turns his head should not
        # condemn a take, and one perfect frame should not rescue one.
        "coverage": median(coverages),
        "holeRatio": median(hole_scores),
        "edgeRoughness": median(edge_scores),
        "sampled": len(coverages),
    }))
    return 0


def hole_ratio(person, cv2):
    """Share of the filled silhouette that the mask left empty.

    A good matte of a person is a solid shape. Holes through the middle mean the
    model lost a shirt against the wall, and those read as transparent patches
    in the bubble."""
    if person.sum() == 0:
        return 1.0
    filled = person.copy()
    contours, _ = cv2.findContours(person, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(filled, contours, -1, 1, thickness=-1)
    area = float(filled.sum())
    return 0.0 if area == 0 else float(filled.sum() - person.sum()) / area


def edge_roughness(person, cv2):
    """Perimeter against the perimeter of an equivalent circle.

    A clean silhouette has a smooth boundary. A ragged one has far more edge for
    the same area, which is what a failing matte looks like around hair."""
    contours, _ = cv2.findContours(person, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return 1.0
    biggest = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(biggest)
    if area <= 0:
        return 1.0
    perimeter = cv2.arcLength(biggest, True)
    ideal = 2.0 * np.sqrt(np.pi * area)
    return float(min(1.0, max(0.0, (perimeter / ideal - 1.0) / 3.0)))


def median(xs):
    return float(np.median(xs)) if xs else 0.0


if __name__ == "__main__":
    sys.exit(main())
