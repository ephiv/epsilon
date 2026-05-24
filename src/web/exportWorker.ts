/**
 * exportWorker.ts — runs the video render pipeline entirely in a worker.
 *
 * Flow:
 *   1. Main thread posts 'start' with all data (timeline, noteskin, settings, …).
 *   2. Worker renders each frame onto an OffscreenCanvas at the requested fps.
 *   3. Worker uses captureStream() → MediaRecorder to encode to WebM.
 *   4. Worker posts 'progress' messages as frames are rendered.
 *   5. Worker posts 'done' with the final Blob, or 'error' on failure.
 */

import { getSnapshotAt, type RenderSettings, type ReplayTimeline } from '../core';
import { renderFrame } from '../render/renderer';
import type { NoteskinSet } from '../render/types';

type ExportStartMessage = {
  type: 'start';
  timeline: ReplayTimeline;
  settings: RenderSettings;
  noteskin: NoteskinSet<ImageBitmap>;
  background: ImageBitmap | null;
  width: number;
  height: number;
  fps: number;
  leadInMs: number;
  tailPadMs: number;
};

type WorkerInMessage = ExportStartMessage | { type: 'cancel' };

export type WorkerOutMessage =
  | { type: 'progress'; frame: number; total: number }
  | { type: 'done'; blob: Blob; filename: string }
  | { type: 'error'; message: string };

let cancelled = false;

self.onmessage = async (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;
  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }
  if (msg.type !== 'start') return;

  cancelled = false;

  const { timeline, settings, noteskin, background, width, height, fps, leadInMs, tailPadMs } = msg;

  try {
    // Prefer OffscreenCanvas captureStream if available (Chrome)
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new Error('Could not get 2d context on OffscreenCanvas.');

    const frameDurationMs = 1000 / fps;
    const durationMs = leadInMs + timeline.beatmap.totalDuration + tailPadMs;
    const totalFrames = Math.ceil(durationMs / frameDurationMs);

    // Collect raw PNG frames — we'll mux them into a WebM via MediaRecorder on an
    // HTMLVideoElement-backed canvas on the main thread. But since we're in a worker
    // without access to MediaRecorder, we post each frame as an ImageBitmap and let
    // the main thread handle MediaRecorder.
    //
    // Strategy: render each frame, send as ImageBitmap transfer (zero-copy).

    self.postMessage({ type: 'progress', frame: 0, total: totalFrames } satisfies WorkerOutMessage);

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      if (cancelled) {
        self.postMessage({ type: 'error', message: 'Export cancelled.' } satisfies WorkerOutMessage);
        return;
      }

      const frameTime = frameIndex * frameDurationMs - leadInMs;

      ctx.clearRect(0, 0, width, height);

      if (settings.exportShutterSamples > 1) {
        for (let s = 0; s < settings.exportShutterSamples; s++) {
          const sampleTime = frameTime + ((s + 0.5) / settings.exportShutterSamples - 0.5) * frameDurationMs;
          const snapshot = getSnapshotAt(timeline, sampleTime);
          // Render to a second canvas for accumulation
          const tempCanvas = new OffscreenCanvas(width, height);
          const tempCtx = tempCanvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
          tempCtx.clearRect(0, 0, width, height);
          renderFrame(tempCtx as unknown as CanvasRenderingContext2D, timeline, snapshot, settings, width, height, noteskin, background);
          ctx.save();
          ctx.globalAlpha = 1 / settings.exportShutterSamples;
          ctx.drawImage(tempCanvas, 0, 0);
          ctx.restore();
        }
      } else {
        const snapshot = getSnapshotAt(timeline, frameTime);
        renderFrame(ctx as unknown as CanvasRenderingContext2D, timeline, snapshot, settings, width, height, noteskin, background);
      }

      // Transfer the frame as ImageBitmap (zero-copy)
      const bitmap = await createImageBitmap(canvas);
      self.postMessage(
        { type: 'frame', frameIndex, bitmap, total: totalFrames } as never,
        [bitmap] as Transferable[],
      );

      // Progress every 10 frames to avoid flooding the message queue
      if (frameIndex % 10 === 0 || frameIndex === totalFrames - 1) {
        self.postMessage({ type: 'progress', frame: frameIndex + 1, total: totalFrames } satisfies WorkerOutMessage);
      }
    }

    // Signal frames complete — main thread finishes encoding
    self.postMessage({ type: 'frames_complete' } as never);

  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    } satisfies WorkerOutMessage);
  }
};
