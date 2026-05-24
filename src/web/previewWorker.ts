import { getSnapshotAt } from '../core';
import { renderFrame } from '../render/renderer';
import type { RenderSettings, ReplayTimeline } from '../core';
import type { NoteskinSet } from '../render/types';

type WorkerMessage =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number }
  | {
      type: 'state';
      timeline: ReplayTimeline | null;
      settings: RenderSettings;
    }
  | {
      type: 'font';
      family: string | null;
      bytes?: ArrayBuffer | null;
    }
  | {
      type: 'assets';
      noteskin?: NoteskinSet<ImageBitmap> | null;
      background?: ImageBitmap | null;
    }
  | { type: 'resize'; width: number; height: number }
  | { type: 'render'; time: number };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let width = 1280;
let height = 720;
let timeline: ReplayTimeline | null = null;
let settings: RenderSettings | null = null;
let noteskin: NoteskinSet<ImageBitmap> | null = null;
let background: ImageBitmap | null = null;
let currentFontLoad: Promise<void> = Promise.resolve();
let pendingRenderTime: number | null = null;
let rafScheduled = false;

function paint(time: number): void {
  if (!ctx || !timeline || !settings || !noteskin) return;
  const snapshot = getSnapshotAt(timeline, time);
  renderFrame(ctx as unknown as CanvasRenderingContext2D, timeline, snapshot, settings, width, height, noteskin, background);
}

function scheduleRender(time: number): void {
  pendingRenderTime = time;
  if (!rafScheduled) {
    rafScheduled = true;
    // Use setTimeout(0) as a microtask flush — OffscreenCanvas workers don't have rAF
    setTimeout(() => {
      rafScheduled = false;
      if (pendingRenderTime !== null) {
        const t = pendingRenderTime;
        pendingRenderTime = null;
        currentFontLoad.finally(() => { paint(t); });
      }
    }, 0);
  }
}

async function registerFontInWorker(family: string | null, bytes: ArrayBuffer | null | undefined): Promise<void> {
  if (!family || !bytes) return;
  if (typeof FontFace === 'undefined') return;
  try {
    const fontFace = new FontFace(family, bytes);
    await fontFace.load();
    const fontSet = (self as unknown as { fonts?: { add: (font: FontFace) => void } }).fonts;
    fontSet?.add(fontFace);
  } catch {
    // Ignore worker font registration failures and fall back to default fonts.
  }
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  if (message.type === 'init') {
    canvas = message.canvas;
    width = message.width;
    height = message.height;
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d');
    return;
  }
  if (message.type === 'state') {
    timeline = message.timeline;
    settings = message.settings;
    return;
  }
  if (message.type === 'font') {
    currentFontLoad = registerFontInWorker(message.family, message.bytes);
    return;
  }
  if (message.type === 'assets') {
    if ('noteskin' in message) {
      noteskin = message.noteskin ?? null;
    }
    if ('background' in message) {
      background = message.background ?? null;
    }
    return;
  }
  if (message.type === 'resize' && canvas) {
    width = message.width;
    height = message.height;
    canvas.width = width;
    canvas.height = height;
    return;
  }
  if (message.type === 'render') {
    scheduleRender(message.time);
  }
};
