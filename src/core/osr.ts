import LZMA from '../vendor/lzma-bundle.js';
import { getClockRate, getModNames, isMirror, isScoreV2 } from './mods';
import type { LifeGraphPoint, ReplayData, ReplayFrame, ReplayHeader, ReplayKeyEvent } from './types';

function parseLifeGraph(raw: string): LifeGraphPoint[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [timeText, valueText] = entry.split('|');
      return {
        time: Number(timeText ?? 0),
        value: Number(valueText ?? 0),
      };
    })
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value));
}

function decodeString(bytes: Uint8Array, start: number, length: number): string {
  return new TextDecoder('utf-8').decode(bytes.subarray(start, start + length));
}

function decompressText(compressed: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const input = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer;
      const result = (LZMA as unknown as { decompressFile: (buffer: ArrayBuffer) => { toString(): string } | Uint8Array | null }).decompressFile(input);
      if (typeof result === 'string') {
        resolve(result);
        return;
      }
      if (result instanceof Uint8Array) {
        resolve(new TextDecoder('utf-8').decode(result));
        return;
      }
      if (result && typeof result.toString === 'function') {
        resolve(result.toString());
        return;
      }
      resolve('');
    } catch (error) {
      reject(error);
    }
  });
}

export function parseReplayHeader(buffer: ArrayBuffer): ReplayHeader {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let position = 0;

  const readByte = () => view.getUint8(position++);
  const readUInt16 = () => {
    const value = view.getUint16(position, true);
    position += 2;
    return value;
  };
  const readInt32 = () => {
    const value = view.getInt32(position, true);
    position += 4;
    return value;
  };
  const readUInt32 = () => {
    const value = view.getUint32(position, true);
    position += 4;
    return value;
  };
  const readInt64 = () => {
    const low = view.getUint32(position, true);
    const high = view.getUint32(position + 4, true);
    position += 8;
    return low + high * 4294967296;
  };
  const readULEB128 = () => {
    let result = 0;
    let shift = 0;
    while (true) {
      const byte = readByte();
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;
    }
    return result;
  };
  const readString = () => {
    const exists = readByte();
    if (exists !== 0x0b) {
      return '';
    }
    const length = readULEB128();
    const value = decodeString(bytes, position, length);
    position += length;
    return value;
  };

  const gameMode = readByte();
  const gameVersion = readInt32();
  const beatmapMD5 = readString();
  const playerName = readString();
  const replayMD5 = readString();
  const count300 = readUInt16();
  const count100 = readUInt16();
  const count50 = readUInt16();
  const countGeki = readUInt16();
  const countKatu = readUInt16();
  const countMiss = readUInt16();
  const totalScore = readUInt32();
  const maxCombo = readUInt16();
  const perfectCombo = readByte() === 1;
  const mods = readUInt32();
  const lifeGraphRaw = readString();
  const timestamp = readInt64();
  const compressedLen = readInt32();
  const compressedOffset = position;

  return {
    gameMode,
    gameVersion,
    beatmapMD5,
    playerName,
    replayMD5,
    count300,
    count100,
    count50,
    countGeki,
    countKatu,
    countMiss,
    totalScore,
    maxCombo,
    perfectCombo,
    mods,
    modNames: getModNames(mods),
    lifeGraph: parseLifeGraph(lifeGraphRaw),
    timestamp,
    compressedLen,
    compressedOffset,
    rawOk: compressedLen >= 0,
    clockRate: getClockRate(mods),
    isDoubleTime: (mods & 64) !== 0 || (mods & 512) !== 0,
    isHalfTime: (mods & 256) !== 0,
    isMirror: isMirror(mods),
    isScoreV2: isScoreV2(mods),
  };
}

export function parseReplayFrames(text: string, maniaMode: boolean): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  let absoluteTime = 0;
  for (const token of text.split(',')) {
    const entry = token.trim();
    if (!entry) continue;
    const parts = entry.split('|');
    if (parts.length < 4) continue;
    const delta = Number(parts[0] ?? 0);
    if (delta === -12345) continue;
    absoluteTime += delta;
    const x = Number(parts[1] ?? 0);
    const y = Number(parts[2] ?? 0);
    const z = Number(parts[3] ?? 0);
    frames.push({
      time: absoluteTime,
      x,
      y,
      z,
      keyMask: maniaMode ? Math.round(x) : z,
    });
  }
  return frames;
}

export function extractReplayKeyEvents(frames: ReplayFrame[], keyCount: number): ReplayKeyEvent[] {
  const events: ReplayKeyEvent[] = [];
  let previousMask = 0;
  for (const frame of frames) {
    const mask = frame.keyMask;
    for (let col = 0; col < keyCount; col += 1) {
      const bit = 1 << col;
      const wasPressed = (previousMask & bit) !== 0;
      const isPressed = (mask & bit) !== 0;
      if (wasPressed === isPressed) continue;
      events.push({
        time: frame.time,
        col,
        pressed: isPressed,
        keyMask: mask,
      });
    }
    previousMask = mask;
  }
  events.sort((a, b) => a.time - b.time || Number(b.pressed) - Number(a.pressed) || a.col - b.col);
  return events;
}

export async function parseReplayBuffer(buffer: ArrayBuffer, keyCount: number): Promise<ReplayData> {
  const header = parseReplayHeader(buffer);
  const compressed = new Uint8Array(buffer, header.compressedOffset, header.compressedLen);
  const text = header.compressedLen > 0 ? await decompressText(compressed) : '';
  const frames = parseReplayFrames(text, header.gameMode === 3);
  const keyEvents = extractReplayKeyEvents(frames, keyCount);
  return {
    header,
    frames,
    keyEvents,
  };
}
