import { describe, expect, it } from 'vitest';
import { buildReplayTimeline, getScrollPosition, getSnapshotAt, parseBeatmapBytes, parseReplayFrames, prepareBeatmapForReplay, type ReplayData } from './index';

function beatmapText(): Uint8Array {
  return new TextEncoder().encode(`osu file format v14

[General]
AudioFilename: song.ogg
Mode: 3

[Metadata]
Title: Test Song
Artist: Test Artist
Version: Deterministic

[Events]
0,0,"bg.jpg",0,0

[Difficulty]
CircleSize:4
OverallDifficulty:5
HPDrainRate:6

[TimingPoints]
0,500,4,2,0,100,1,0
1000,250,4,2,0,100,1,0
1500,-50,4,2,0,100,0,0

[HitObjects]
64,192,1000,1,8,0:0:0:0:
192,192,2000,128,2,3000:0:0:0:0:
`);
}

function replayForBeatmap(scoreV2 = false): ReplayData {
  const beatmap = parseBeatmapBytes(beatmapText());
  return {
    header: {
      gameMode: 3,
      gameVersion: 20250101,
      beatmapMD5: beatmap.rawMd5,
      playerName: 'tester',
      replayMD5: 'abc',
      count300: 0,
      count100: 0,
      count50: 0,
      countGeki: 0,
      countKatu: 0,
      countMiss: 0,
      totalScore: 0,
      maxCombo: 0,
      perfectCombo: false,
      mods: scoreV2 ? 536870912 : 0,
      modNames: scoreV2 ? ['SV2'] : [],
      lifeGraph: [{ time: 0, value: 0.8 }, { time: 2000, value: 1 }],
      timestamp: 0,
      compressedLen: 0,
      compressedOffset: 0,
      rawOk: true,
      clockRate: 1,
      isDoubleTime: false,
      isHalfTime: false,
      isMirror: false,
      isScoreV2: scoreV2,
    },
    frames: [],
    keyEvents: [
      { time: 1000, col: 0, pressed: true, keyMask: 1 },
      { time: 1010, col: 0, pressed: false, keyMask: 0 },
      { time: 2000, col: 1, pressed: true, keyMask: 2 },
      { time: 3000, col: 1, pressed: false, keyMask: 0 },
    ],
  };
}

describe('beatmap preparation', () => {
  it('applies mirror and DT normalization', () => {
    const beatmap = parseBeatmapBytes(beatmapText());
    const prepared = prepareBeatmapForReplay(beatmap, 1.5, true, false);
    expect(prepared.hitObjects[0].startTime).toBeCloseTo(1000 / 1.5);
    expect(prepared.hitObjects[0].col).toBe(3);
  });

  it('integrates BPM and SV into scroll position', () => {
    const beatmap = parseBeatmapBytes(beatmapText());
    const prepared = prepareBeatmapForReplay(beatmap, 1, false, false);
    const before = getScrollPosition(prepared, 900);
    const after = getScrollPosition(prepared, 1700);
    expect(after - before).toBeGreaterThan(900);
  });
});

describe('replay parsing', () => {
  it('parses replay frame deltas into absolute times', () => {
    const frames = parseReplayFrames('16|1|192|0,32|0|192|0,-12345|0|0|0,', true);
    expect(frames).toHaveLength(2);
    expect(frames[0].time).toBe(16);
    expect(frames[1].time).toBe(48);
    expect(frames[0].keyMask).toBe(1);
  });
});

describe('timeline simulation', () => {
  it('resolves taps and scorev1 holds', () => {
    const beatmap = parseBeatmapBytes(beatmapText());
    const timeline = buildReplayTimeline(beatmap, replayForBeatmap(false));
    expect(timeline.finalScore.counts['320']).toBe(2);
    expect(timeline.finalScore.counts.miss).toBe(0);
    expect(timeline.judgements).toHaveLength(2);
    expect(timeline.sampleEvents).toHaveLength(3);
    const snapshot = getSnapshotAt(timeline, 2500);
    expect(snapshot.keyStates[1]).toBe(true);
    expect(snapshot.score.combo).toBe(1);
    expect(snapshot.life).toBe(1);
  });

  it('splits scorev2 hold head and tail', () => {
    const beatmap = parseBeatmapBytes(beatmapText());
    const timeline = buildReplayTimeline(beatmap, replayForBeatmap(true));
    expect(timeline.judgements.map((judgement) => judgement.part)).toEqual(['tap', 'head', 'tail']);
    expect(timeline.finalScore.counts['320']).toBe(3);
    expect(timeline.sampleEvents.map((event) => event.part)).toEqual(['tap', 'head', 'tail']);
    expect(timeline.sampleEvents[0].layers.some((layer) => layer.kind === 'clap')).toBe(true);
    expect(timeline.sampleEvents[1].layers.some((layer) => layer.kind === 'whistle')).toBe(true);
    const snapshot = getSnapshotAt(timeline, 2500);
    expect(snapshot.holdStates[1].holding).toBe(true);
  });

  it('treats late meh taps as misses and advances to the next note', () => {
    const beatmap = parseBeatmapBytes(
      new TextEncoder().encode(`osu file format v14

[General]
AudioFilename: song.ogg
Mode: 3

[Metadata]
Title: Late Test
Artist: Test Artist
Version: Late

[Difficulty]
CircleSize:4
OverallDifficulty:5
HPDrainRate:5

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
64,192,1000,1,0,0:0:0:0:
64,192,1140,1,0,0:0:0:0:
`),
    );
    const replay: ReplayData = {
      ...replayForBeatmap(false),
      header: {
        ...replayForBeatmap(false).header,
        beatmapMD5: beatmap.rawMd5,
        lifeGraph: [],
      },
      keyEvents: [{ time: 1140, col: 0, pressed: true, keyMask: 1 }],
    };
    const timeline = buildReplayTimeline(beatmap, replay);
    expect(timeline.judgements.map((judgement) => judgement.grade)).toEqual(['miss', 320]);
  });

  it('rejects mismatched beatmap md5s', () => {
    const beatmap = parseBeatmapBytes(beatmapText());
    const replay = replayForBeatmap(false);
    replay.header.beatmapMD5 = 'nope';
    expect(() => buildReplayTimeline(beatmap, replay)).toThrow(/beatmap md5/i);
  });

  it('caps scorev2 hold tail at 50 after a body break', () => {
    const beatmap = parseBeatmapBytes(beatmapText());
    const replay: ReplayData = {
      ...replayForBeatmap(true),
      keyEvents: [
        { time: 1000, col: 0, pressed: true, keyMask: 1 },
        { time: 1010, col: 0, pressed: false, keyMask: 0 },
        { time: 2000, col: 1, pressed: true, keyMask: 2 },
        { time: 2400, col: 1, pressed: false, keyMask: 0 },
        { time: 2980, col: 1, pressed: true, keyMask: 2 },
        { time: 3000, col: 1, pressed: false, keyMask: 0 },
      ],
    };
    const timeline = buildReplayTimeline(beatmap, replay);
    expect(timeline.judgements.map((judgement) => judgement.grade)).toEqual([320, 320, 50]);
  });
});
