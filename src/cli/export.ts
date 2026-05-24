import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import { registerFont } from '@napi-rs/canvas/node-canvas';
import { buildReplayTimeline, getSnapshotAt, parseBeatmapBytes, parseReplayBuffer, type ExportJobOptions, type HitsoundLayer, type RenderSettings, type ReplayTimeline } from '../core';
import { buildNoteskinFromSources } from '../render/noteskin';
import { renderFrame } from '../render/renderer';
import { mergeRenderSettings } from '../render/settings';
import type { NoteskinSet } from '../render/types';
import { NOTESKIN_ASSETS } from '../../noteskin_assets.js';

type NodeBitmap = Awaited<ReturnType<typeof loadImage>> | Canvas;

const USAGE =
  'Usage: npm run export:video -- --osu <beatmap.osu> --osr <replay.osr> [--audio <audio>] [--bg <background>] [--skin-dir <dir>] [--font <font.ttf>] [--settings <file>] [--width 1920] [--height 1080] [--fps 60] [--lead-in-ms 0] [--tail-pad-ms 2000] --out <render.mp4>';

function usage(): never {
  throw new Error(USAGE);
}

function parseArgs(argv: string[]): ExportJobOptions {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      args.set(token, 'true');
      continue;
    }
    args.set(token, value);
    index += 1;
  }

  const osuPath = args.get('--osu');
  const osrPath = args.get('--osr');
  const outPath = args.get('--out');
  if (!osuPath || !osrPath || !outPath) usage();

  return {
    osuPath,
    osrPath,
    audioPath: args.get('--audio') || undefined,
    bgPath: args.get('--bg') || undefined,
    skinDir: args.get('--skin-dir') || undefined,
    fontPath: args.get('--font') || undefined,
    settingsPath: args.get('--settings') || undefined,
    width: Number(args.get('--width') || 1920),
    height: Number(args.get('--height') || 1080),
    fps: Number(args.get('--fps') || 60),
    leadInMs: Number(args.get('--lead-in-ms') || 0),
    tailPadMs: Number(args.get('--tail-pad-ms') || 2000),
    outPath,
  };
}

async function pathExists(filePath: string | undefined): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function cropNodeBitmap(image: NodeBitmap, sx: number, sy: number, sw: number, sh: number): Promise<NodeBitmap | null> {
  try {
    const canvas = createCanvas(Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh)));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image as never, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch {
    return null;
  }
}

async function buildDefaultNoteskinNode(): Promise<NoteskinSet<NodeBitmap>> {
  const assetMap = NOTESKIN_ASSETS as Record<string, string>;
  const sources = [
    ...Object.entries(assetMap).map(([name, source]) => ({ name, source })),
    { name: 'default-judgement-strip.png', source: path.resolve(process.cwd(), 'public', 'judgements', 'default-judgement-strip.png') },
  ];
  return buildNoteskinFromSources(
    'AmbieZeroTwo',
    sources,
    async (source) => {
      try {
        return await loadImage(source);
      } catch {
        return null;
      }
    },
    cropNodeBitmap,
  );
}

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await walkFiles(fullPath)));
    } else {
      output.push(fullPath);
    }
  }
  return output;
}

async function buildNoteskinFromDirectory(directory: string): Promise<NoteskinSet<NodeBitmap>> {
  const files = await walkFiles(directory);
  const sources = files.map((file) => ({ name: path.basename(file), source: file }));
  return buildNoteskinFromSources(
    path.basename(directory),
    sources,
    async (filePath) => {
      try {
        return await loadImage(filePath);
      } catch {
        return null;
      }
    },
    cropNodeBitmap,
  );
}

async function loadSettings(settingsPath: string | undefined): Promise<RenderSettings> {
  if (!settingsPath) return mergeRenderSettings();
  const raw = await fs.readFile(settingsPath, 'utf8');
  return mergeRenderSettings(JSON.parse(raw) as Partial<RenderSettings>);
}

interface DecodedWav {
  sampleRate: number;
  channels: Float32Array[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function decodeWav(buffer: Buffer): DecodedWav {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Only RIFF/WAVE hitsound files are supported for offline mixing.');
  }

  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkId === 'fmt ') {
      format = buffer.readUInt16LE(chunkDataOffset);
      channels = buffer.readUInt16LE(chunkDataOffset + 2);
      sampleRate = buffer.readUInt32LE(chunkDataOffset + 4);
      bitsPerSample = buffer.readUInt16LE(chunkDataOffset + 14);
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }
    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!dataOffset || !dataSize || !sampleRate || !channels) {
    throw new Error('Invalid WAV hitsound file.');
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / Math.max(1, channels * bytesPerSample));
  const output = Array.from({ length: channels }, () => new Float32Array(frameCount));

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sampleOffset = dataOffset + (frame * channels + channel) * bytesPerSample;
      let sample = 0;
      if (format === 1 && bitsPerSample === 16) {
        sample = buffer.readInt16LE(sampleOffset) / 32768;
      } else if (format === 1 && bitsPerSample === 8) {
        sample = (buffer.readUInt8(sampleOffset) - 128) / 128;
      } else if (format === 1 && bitsPerSample === 24) {
        sample = buffer.readIntLE(sampleOffset, 3) / 8388608;
      } else if (format === 1 && bitsPerSample === 32) {
        sample = buffer.readInt32LE(sampleOffset) / 2147483648;
      } else if (format === 3 && bitsPerSample === 32) {
        sample = buffer.readFloatLE(sampleOffset);
      } else {
        throw new Error(`Unsupported WAV hitsound format ${format}/${bitsPerSample}.`);
      }
      output[channel][frame] = clamp(sample, -1, 1);
    }
  }

  return { sampleRate, channels: output };
}

function writeStereoWav(filePath: string, left: Float32Array, right: Float32Array, sampleRate: number): Promise<void> {
  const frameCount = Math.min(left.length, right.length);
  const dataSize = frameCount * 2 * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 4, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 4, 'ascii');
  buffer.write('fmt ', 12, 4, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 4, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < frameCount; index += 1) {
    buffer.writeInt16LE(Math.round(clamp(left[index], -1, 1) * 32767), 44 + index * 4);
    buffer.writeInt16LE(Math.round(clamp(right[index], -1, 1) * 32767), 46 + index * 4);
  }
  return fs.writeFile(filePath, buffer);
}

function stripHitsoundIndex(filename: string): string {
  return filename.replace(/(\D)\d+(?=\.wav$)/i, '$1');
}

async function resolveHitsoundPath(layer: HitsoundLayer, beatmapDir: string, skinDir: string | undefined): Promise<string | null> {
  const candidates: string[] = [];
  if (layer.kind === 'custom') {
    candidates.push(path.join(beatmapDir, layer.filename));
  } else {
    candidates.push(path.join(beatmapDir, layer.filename));
    candidates.push(path.join(beatmapDir, stripHitsoundIndex(layer.filename)));
    if (skinDir) {
      candidates.push(path.join(skinDir, layer.filename));
      candidates.push(path.join(skinDir, stripHitsoundIndex(layer.filename)));
    }
  }

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    if (!candidate.toLowerCase().endsWith('.wav')) continue;
    return candidate;
  }
  return null;
}

async function buildHitsoundTrack(
  timeline: ReplayTimeline,
  beatmapDir: string,
  skinDir: string | undefined,
  outputPath: string,
  durationMs: number,
  leadInMs: number,
  outputSampleRate = 48000,
): Promise<string | undefined> {
  const left = new Float32Array(Math.ceil((durationMs / 1000) * outputSampleRate) + 1);
  const right = new Float32Array(left.length);
  const cache = new Map<string, DecodedWav>();
  let mixed = false;

  for (const event of timeline.sampleEvents) {
    const eventOffset = Math.round(((event.time + leadInMs) / 1000) * outputSampleRate);
    if (eventOffset >= left.length) continue;
    for (const layer of event.layers) {
      const samplePath = await resolveHitsoundPath(layer, beatmapDir, skinDir);
      if (!samplePath) continue;
      let decoded = cache.get(samplePath);
      if (!decoded) {
        decoded = decodeWav(await fs.readFile(samplePath));
        cache.set(samplePath, decoded);
      }
      const gain = clamp(layer.volume / 100, 0, 1) * 0.35;
      const sourceLength = decoded.channels[0]?.length ?? 0;
      const resampledLength = Math.ceil((sourceLength / decoded.sampleRate) * outputSampleRate);
      for (let sampleIndex = 0; sampleIndex < resampledLength; sampleIndex += 1) {
        const targetIndex = eventOffset + sampleIndex;
        if (targetIndex >= left.length) break;
        const sourcePosition = (sampleIndex * decoded.sampleRate) / outputSampleRate;
        const sourceBase = Math.floor(sourcePosition);
        const sourceNext = Math.min(sourceBase + 1, sourceLength - 1);
        const t = sourcePosition - sourceBase;
        const monoOrLeft = decoded.channels[0][sourceBase] * (1 - t) + decoded.channels[0][sourceNext] * t;
        const rightSource = decoded.channels[1] ?? decoded.channels[0];
        const rightValue = rightSource[sourceBase] * (1 - t) + rightSource[sourceNext] * t;
        left[targetIndex] += monoOrLeft * gain;
        right[targetIndex] += rightValue * gain;
        mixed = true;
      }
    }
  }

  if (!mixed) return undefined;

  let maxAbs = 0;
  for (let index = 0; index < left.length; index += 1) {
    maxAbs = Math.max(maxAbs, Math.abs(left[index]), Math.abs(right[index]));
  }
  if (maxAbs > 0.98) {
    const scale = 0.98 / maxAbs;
    for (let index = 0; index < left.length; index += 1) {
      left[index] *= scale;
      right[index] *= scale;
    }
  }

  await writeStereoWav(outputPath, left, right, outputSampleRate);
  return outputPath;
}

function ensureFfmpeg(): void {
  const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error('ffmpeg is required for video export and was not found on PATH.');
  }
}

function outputProfile(outPath: string): {
  videoArgs: string[];
  audioArgs: string[];
  tailArgs: string[];
} {
  const extension = path.extname(outPath).toLowerCase();
  switch (extension) {
    case '.webm':
      return {
        videoArgs: ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-row-mt', '1', '-deadline', 'good'],
        audioArgs: ['-c:a', 'libopus', '-b:a', '192k'],
        tailArgs: [],
      };
    case '.mov':
      return {
        videoArgs: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p'],
        audioArgs: ['-c:a', 'aac', '-b:a', '256k'],
        tailArgs: [],
      };
    case '.mkv':
      return {
        videoArgs: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p'],
        audioArgs: ['-c:a', 'aac', '-b:a', '256k'],
        tailArgs: [],
      };
    case '.mp4':
    default:
      return {
        videoArgs: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p'],
        audioArgs: ['-c:a', 'aac', '-b:a', '256k'],
        tailArgs: ['-movflags', '+faststart'],
      };
  }
}

async function muxVideo(
  options: ExportJobOptions,
  durationMs: number,
  clockRate: number,
  audioPath: string | undefined,
  hitsoundPath: string | undefined,
): Promise<{
  process: ChildProcessByStdio<Writable, null, Readable>;
  done: Promise<void>;
}> {
  ensureFfmpeg();
  const profile = outputProfile(options.outPath);
  const filters = [`scale=trunc(iw/2)*2:trunc(ih/2)*2`, 'format=yuv420p'];
  const videoArgs = ['-y', '-f', 'image2pipe', '-framerate', String(options.fps), '-vcodec', 'png', '-i', '-'];
  const args = [...videoArgs];

  if (audioPath && hitsoundPath) {
    const delay = Math.max(0, Math.round(options.leadInMs));
    const filterComplex = [
      `[1:a]asetrate=sample_rate*${clockRate},aresample=sample_rate,adelay=${delay}|${delay},atrim=duration=${(durationMs / 1000).toFixed(3)}[song]`,
      `[2:a]atrim=duration=${(durationMs / 1000).toFixed(3)}[hits]`,
      `[song][hits]amix=inputs=2:normalize=0[a]`,
    ].join(';');
    args.push('-i', audioPath, '-i', hitsoundPath, '-filter:v', filters.join(','), '-filter_complex', filterComplex, '-map', '0:v:0', '-map', '[a]', ...profile.videoArgs, ...profile.audioArgs, ...profile.tailArgs, '-shortest', options.outPath);
  } else if (audioPath) {
    const delay = Math.max(0, Math.round(options.leadInMs));
    const filterComplex = `[1:a]asetrate=sample_rate*${clockRate},aresample=sample_rate,adelay=${delay}|${delay},atrim=duration=${(
      durationMs / 1000
    ).toFixed(3)}[a]`;
    args.push('-i', audioPath, '-filter:v', filters.join(','), '-filter_complex', filterComplex, '-map', '0:v:0', '-map', '[a]', ...profile.videoArgs, ...profile.audioArgs, ...profile.tailArgs, '-shortest', options.outPath);
  } else if (hitsoundPath) {
    args.push('-i', hitsoundPath, '-filter:v', filters.join(','), '-map', '0:v:0', '-map', '1:a:0', ...profile.videoArgs, ...profile.audioArgs, ...profile.tailArgs, '-shortest', options.outPath);
  } else {
    args.push('-vf', filters.join(','), ...profile.videoArgs, ...profile.tailArgs, options.outPath);
  }

  const process = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  process.stderr.setEncoding('utf8');
  process.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<void>((resolve, reject) => {
    process.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || 'ffmpeg video encode failed.'));
      }
    });
    process.on('error', reject);
  });
  return { process, done };
}

async function writeFrameToEncoder(process: ChildProcessByStdio<Writable, null, Readable>, frameBytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      process.stdin.off('drain', onDrain);
      reject(error);
    };
    const onDrain = () => {
      process.stdin.off('error', onError);
      resolve();
    };
    process.stdin.once('error', onError);
    const wrote = process.stdin.write(Buffer.from(frameBytes));
    if (wrote) {
      process.stdin.off('error', onError);
      resolve();
    } else {
      process.stdin.once('drain', onDrain);
    }
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const settings = await loadSettings(options.settingsPath);
  if (options.fontPath && settings.customFont) {
    registerFont(path.resolve(options.fontPath), { family: settings.customFont });
  }
  const osuBytes = new Uint8Array(await fs.readFile(options.osuPath));
  const osrBuffer = await fs.readFile(options.osrPath);
  const beatmap = parseBeatmapBytes(osuBytes);
  const replay = await parseReplayBuffer(
    osrBuffer.buffer.slice(osrBuffer.byteOffset, osrBuffer.byteOffset + osrBuffer.byteLength),
    beatmap.keyCount,
  );
  const timeline = buildReplayTimeline(beatmap, replay, { validateLifeGraph: true });
  const noteskin =
    options.skinDir && (await pathExists(options.skinDir)) ? await buildNoteskinFromDirectory(options.skinDir) : await buildDefaultNoteskinNode();

  const beatmapDir = path.dirname(options.osuPath);
  const resolvedAudioPath =
    options.audioPath || ((await pathExists(path.join(beatmapDir, timeline.beatmap.audioFilename))) ? path.join(beatmapDir, timeline.beatmap.audioFilename) : undefined);
  const resolvedBgPath =
    options.bgPath || ((await pathExists(path.join(beatmapDir, timeline.beatmap.bgFilename))) ? path.join(beatmapDir, timeline.beatmap.bgFilename) : undefined);
  const background = resolvedBgPath ? await loadImage(resolvedBgPath) : null;

  const canvas = createCanvas(options.width, options.height);
  const ctx = canvas.getContext('2d');
  const sampleCanvas =
    settings.exportShutterSamples > 1 ? createCanvas(options.width, options.height) : null;
  const sampleCtx = sampleCanvas?.getContext('2d') ?? null;
  const frameDuration = 1000 / options.fps;
  const durationMs = options.leadInMs + timeline.beatmap.totalDuration + options.tailPadMs;
  const totalFrames = Math.ceil(durationMs / frameDuration);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mania-render-'));
  const hitsoundPath = await buildHitsoundTrack(
    timeline,
    beatmapDir,
    options.skinDir,
    path.join(tempDir, 'hitsounds.wav'),
    durationMs,
    options.leadInMs,
  );
  const encoder = await muxVideo(options, durationMs, timeline.beatmap.clockRate, resolvedAudioPath, hitsoundPath);

  try {
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      const frameTime = frameIndex * frameDuration - options.leadInMs;
      ctx.clearRect(0, 0, options.width, options.height);
      if (settings.exportShutterSamples > 1 && sampleCanvas && sampleCtx) {
        for (let sample = 0; sample < settings.exportShutterSamples; sample += 1) {
          const sampleTime = frameTime + ((sample + 0.5) / settings.exportShutterSamples - 0.5) * frameDuration;
          const snapshot = getSnapshotAt(timeline, sampleTime);
          sampleCtx.clearRect(0, 0, options.width, options.height);
          renderFrame(sampleCtx as unknown as CanvasRenderingContext2D, timeline, snapshot, settings, options.width, options.height, noteskin, background);
          ctx.save();
          ctx.globalAlpha = 1 / settings.exportShutterSamples;
          ctx.drawImage(sampleCanvas, 0, 0);
          ctx.restore();
        }
      } else {
        const snapshot = getSnapshotAt(timeline, frameTime);
        renderFrame(ctx as unknown as CanvasRenderingContext2D, timeline, snapshot, settings, options.width, options.height, noteskin, background);
      }

      const encoded = await canvas.encode('png');
      await writeFrameToEncoder(encoder.process, encoded);
    }
    encoder.process.stdin.end();
    await encoder.done;
  } finally {
    encoder.process.kill();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  process.stdout.write(`Exported ${options.outPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
