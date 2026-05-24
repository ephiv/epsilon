import type { BeatmapFile, HitSampleInfo, HitsoundEvent, HitsoundKind, HitsoundLayer, ManiaHitObject, ManiaTimingPoint, PreparedBeatmap } from './types';

const SAMPLE_SET_NAMES: Record<number, string> = {
  1: 'normal',
  2: 'soft',
  3: 'drum',
};

function fallbackSampleSet(sampleSet: number): number {
  return sampleSet >= 1 && sampleSet <= 3 ? sampleSet : 1;
}

export function getTimingPointAtTime(beatmap: BeatmapFile | PreparedBeatmap, time: number): ManiaTimingPoint {
  let current = beatmap.timingPoints[0] ?? {
    time: 0,
    beatLength: 500,
    meter: 4,
    uninherited: true,
    sampleSet: 1,
    sampleIndex: 0,
    volume: 100,
    effects: 0,
  };
  for (const point of beatmap.timingPoints) {
    if (point.time > time) break;
    current = point;
  }
  return current;
}

function resolveHitSampleInfo(beatmap: BeatmapFile | PreparedBeatmap, object: ManiaHitObject, sample: HitSampleInfo, eventTime: number): HitSampleInfo {
  const timing = getTimingPointAtTime(beatmap, eventTime);
  const normalSet = sample.normalSet !== 0 ? sample.normalSet : fallbackSampleSet(timing.sampleSet);
  const additionSet = sample.additionSet !== 0 ? sample.additionSet : normalSet;
  const index = sample.index !== 0 ? sample.index : timing.sampleIndex;
  const volume = sample.volume !== 0 ? sample.volume : timing.volume;
  return {
    normalSet,
    additionSet,
    index,
    volume,
    filename: sample.filename.trim(),
  };
}

function buildSampleFilename(kind: Exclude<HitsoundKind, 'custom'>, sampleSet: number, index: number): string {
  const sampleSetName = SAMPLE_SET_NAMES[fallbackSampleSet(sampleSet)] ?? SAMPLE_SET_NAMES[1];
  const suffix = index <= 1 ? '' : String(index);
  return `${sampleSetName}-hit${kind}${suffix}.wav`;
}

export function resolveHitsoundLayers(
  beatmap: BeatmapFile | PreparedBeatmap,
  object: ManiaHitObject,
  part: HitsoundEvent['part'],
  eventTime: number,
): HitsoundLayer[] {
  const sample = resolveHitSampleInfo(beatmap, object, object.sample, eventTime);
  if (sample.filename) {
    return [
      {
        kind: 'custom',
        sampleSet: sample.normalSet,
        index: sample.index,
        volume: sample.volume,
        filename: sample.filename,
      },
    ];
  }

  const layers: HitsoundLayer[] = [
    {
      kind: 'normal',
      sampleSet: sample.normalSet,
      index: sample.index,
      volume: sample.volume,
      filename: buildSampleFilename('normal', sample.normalSet, sample.index),
    },
  ];

  const additions: Array<{ bit: number; kind: Exclude<HitsoundKind, 'custom' | 'normal'> }> = [
    { bit: 2, kind: 'whistle' },
    { bit: 4, kind: 'finish' },
    { bit: 8, kind: 'clap' },
  ];
  for (const addition of additions) {
    if ((object.hitSound & addition.bit) === 0) continue;
    layers.push({
      kind: addition.kind,
      sampleSet: sample.additionSet,
      index: sample.index,
      volume: sample.volume,
      filename: buildSampleFilename(addition.kind, sample.additionSet, sample.index),
    });
  }

  return layers;
}
