/**
 * ffmpegPaths.ts — Resolves ffmpeg and ffprobe binary paths from npm packages.
 * Works in both development (sandbox has system ffmpeg) and production (Cloud Run, Node-only).
 * Falls back to system binaries if npm packages aren't available.
 */

import { execSync } from "child_process";
import { existsSync, chmodSync } from "fs";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let _ffmpegPath: string | null = null;
let _ffprobePath: string | null = null;

export function getFFmpegPath(): string {
  if (_ffmpegPath) return _ffmpegPath;

  // Try npm package first
  try {
    const installer = require("@ffmpeg-installer/ffmpeg");
    const p = installer.path;
    if (p && existsSync(p)) {
      try { chmodSync(p, 0o755); } catch { /* ignore */ }
      _ffmpegPath = p;
      return p;
    }
  } catch { /* fallback */ }

  // Fallback to system ffmpeg
  try {
    _ffmpegPath = execSync("which ffmpeg", { encoding: "utf-8" }).trim();
    return _ffmpegPath;
  } catch {
    _ffmpegPath = "ffmpeg";
    return _ffmpegPath;
  }
}

export function getFFprobePath(): string {
  if (_ffprobePath) return _ffprobePath;

  // Try npm package first
  try {
    const installer = require("@ffprobe-installer/ffprobe");
    const p = installer.path;
    if (p && existsSync(p)) {
      try { chmodSync(p, 0o755); } catch { /* ignore */ }
      _ffprobePath = p;
      return p;
    }
  } catch { /* fallback */ }

  // Fallback to system ffprobe
  try {
    _ffprobePath = execSync("which ffprobe", { encoding: "utf-8" }).trim();
    return _ffprobePath;
  } catch {
    _ffprobePath = "ffprobe";
    return _ffprobePath;
  }
}
