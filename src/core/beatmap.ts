import { md5Hex, decodeText } from './utils';
import type { BeatmapFile, HitSampleInfo, ManiaHitObject, ManiaTimingPoint, PreparedBeatmap, ScrollSegment } from './types';

function parseHitSample(raw: string | undefined): HitSampleInfo {
  const parts = (raw ?? '').split(':');
  return {
    normalSet: Number(parts[0] ?? 0),
    additionSet: Number(parts[1] ?? 0),
    index: Number(parts[2] ?? 0),
    volume: Number(parts[3] ?? 0),
    filename: parts.slice(4).join(':').trim(),
  };
}

function parseTimingPoint(parts: string[]): ManiaTimingPoint {
  return {
    time: Number(parts[0] ?? 0),
    beatLength: Number(parts[1] ?? 0),
    meter: Number(parts[2] ?? 4),
    sampleSet: Number(parts[3] ?? 0),
    sampleIndex: Number(parts[4] ?? 0),
    volume: Number(parts[5] ?? 100),
    uninherited: Number(parts[6] ?? 1) === 1,
    effects: Number(parts[7] ?? 0),
  };
}

function parseHitObject(parts: string[], keyCount: number, id: number): ManiaHitObject {
  const x = Number(parts[0] ?? 0);
  const startTime = Number(parts[2] ?? 0);
  const type = Number(parts[3] ?? 0);
  const hitSound = Number(parts[4] ?? 0);
  const isHold = (type & 128) !== 0;
  const extras = (parts[5] ?? '').split(':');
  const endTime = isHold ? Number(extras[0] ?? startTime) || startTime : startTime;
  const sample = isHold ? parseHitSample(extras.slice(1).join(':')) : parseHitSample(parts[5]);
  const col = Math.max(0, Math.min(keyCount - 1, Math.floor((x * keyCount) / 512)));
  return {
    id,
    col,
    startTime,
    endTime,
    isHold,
    hitSound,
    sample,
  };
}

export function parseBeatmapBytes(bytes: Uint8Array): BeatmapFile {
  const rawText = decodeText(bytes);
  const rawMd5 = md5Hex(bytes);
  const lines = rawText.split(/\r?\n/);
  let section = '';
  const beatmap: BeatmapFile = {
    rawText,
    rawMd5,
    mode: 3,
    title: '',
    artist: '',
    version: '',
    audioFilename: '',
    bgFilename: '',
    keyCount: 4,
    overallDifficulty: 5,
    hpDrainRate: 5,
    timingPoints: [],
    hitObjects: [],
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1);
      continue;
    }

    const value = () => line.split(':').slice(1).join(':').trim();

    if (section === 'General') {
      if (line.startsWith('AudioFilename:')) beatmap.audioFilename = value();
      if (line.startsWith('Mode:')) beatmap.mode = Number(value() || 0);
    }
    if (section === 'Metadata') {
      if (line.startsWith('Title:')) beatmap.title = value();
      if (line.startsWith('Artist:')) beatmap.artist = value();
      if (line.startsWith('Version:')) beatmap.version = value();
    }
    if (section === 'Events') {
      const parts = line.split(',');
      if ((parts[0] === '0' || parts[0] === 'Background') && parts[2]) {
        beatmap.bgFilename = parts[2].replace(/"/g, '').trim();
      }
    }
    if (section === 'Difficulty') {
      if (line.startsWith('CircleSize:')) beatmap.keyCount = Number(value() || 4);
      if (line.startsWith('OverallDifficulty:')) beatmap.overallDifficulty = Number(value() || 5);
      if (line.startsWith('HPDrainRate:')) beatmap.hpDrainRate = Number(value() || 5);
    }
    if (section === 'TimingPoints') {
      const parts = line.split(',');
      if (parts.length >= 2) beatmap.timingPoints.push(parseTimingPoint(parts));
    }
    if (section === 'HitObjects') {
      const parts = line.split(',');
      if (parts.length >= 5) {
        beatmap.hitObjects.push(parseHitObject(parts, beatmap.keyCount, beatmap.hitObjects.length));
      }
    }
  }

  beatmap.hitObjects.sort((a, b) => a.startTime - b.startTime || a.col - b.col || a.id - b.id);
  return beatmap;
}

function buildScrollSegments(beatmap: BeatmapFile, clockRate: number): { baseBeatLength: number; segments: ScrollSegment[] } {
  const positiveTiming = beatmap.timingPoints.filter((point) => point.uninherited && point.beatLength > 0);
  const baseBeatLength = positiveTiming[0]?.beatLength ?? 500;
  const sorted = [...beatmap.timingPoints].sort((a, b) => a.time - b.time);
  let beatLength = baseBeatLength;
  let sv = 1;
  let lastTime = 0;
  let scrollAtStart = 0;
  const segments: ScrollSegment[] = [];

  for (const point of sorted) {
    const pointTime = point.time / clockRate;
    if (pointTime > lastTime) {
      const factor = sv * (baseBeatLength / beatLength);
      segments.push({
        startTime: lastTime,
        endTime: pointTime,
        beatLength,
        sv,
        factor,
        scrollAtStart,
      });
      scrollAtStart += (pointTime - lastTime) * factor;
    }

    if (point.uninherited && point.beatLength > 0) {
      beatLength = point.beatLength;
    } else if (!point.uninherited && point.beatLength < 0) {
      sv = -100 / point.beatLength;
    }

    lastTime = pointTime;
  }

  const finalFactor = sv * (baseBeatLength / beatLength);
  segments.push({
    startTime: lastTime,
    endTime: Number.POSITIVE_INFINITY,
    beatLength,
    sv,
    factor: finalFactor,
    scrollAtStart,
  });

  return { baseBeatLength, segments };
}

export function prepareBeatmapForReplay(beatmap: BeatmapFile, clockRate: number, mirror: boolean, scoreV2: boolean): PreparedBeatmap {
  const normalizedTiming = beatmap.timingPoints.map((point) => ({
    ...point,
    time: point.time / clockRate,
  }));
  const normalizedObjects = beatmap.hitObjects.map((object) => ({
    ...object,
    col: mirror ? beatmap.keyCount - object.col - 1 : object.col,
    startTime: object.startTime / clockRate,
    endTime: object.endTime / clockRate,
  }));
  const totalDuration = normalizedObjects.reduce((max, object) => Math.max(max, object.endTime), 0) + 2000;
  const totalJudgementUnits = normalizedObjects.reduce((count, object) => count + (object.isHold && scoreV2 ? 2 : 1), 0);
  const scroll = buildScrollSegments(
    {
      ...beatmap,
      timingPoints: normalizedTiming,
      hitObjects: normalizedObjects,
    },
    1,
  );

  return {
    ...beatmap,
    clockRate,
    isMirror: mirror,
    totalJudgementUnits,
    totalDuration,
    baseBeatLength: scroll.baseBeatLength,
    timingPoints: normalizedTiming,
    hitObjects: normalizedObjects,
    scrollSegments: scroll.segments,
  };
}

export function getScrollPosition(beatmap: PreparedBeatmap, time: number): number {
  const segments = beatmap.scrollSegments;
  let lo = 0;
  let hi = segments.length - 1;
  let found = segments[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid];
    if (segment.startTime <= time) {
      found = segment;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found.scrollAtStart + (time - found.startTime) * found.factor;
}
