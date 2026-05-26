import { prepareBeatmapForReplay } from './beatmap';
import { resolveHitsoundLayers } from './hitsounds';
import { applyJudgement, createScoreAccumulator, getStableWindows, judgeAsymmetricTap, judgeTap, judgeScoreV1Hold, scaleWindows } from './maniaRules';
import { cloneScoreState, lowerBound } from './utils';
import type {
  BeatmapFile,
  FrameSnapshot,
  HoldResolution,
  HitsoundEvent,
  JudgementEvent,
  LifeGraphPoint,
  ManiaGrade,
  PreparedBeatmap,
  ReplayBuildOptions,
  ReplayData,
  ReplayKeyEvent,
  ReplayTimeline,
  ScoreState,
  TapResolution,
} from './types';

interface InternalHoldState {
  objectId: number;
  col: number;
  startTime: number;
  endTime: number;
  headResolved: boolean;
  headGrade: ManiaGrade | null;
  headHitTime: number | null;
  holding: boolean;
  bodyBrokenAt: number | null;
  tailResolved: boolean;
  tailGrade: ManiaGrade | null;
  tailHitTime: number | null;
  finalResolved: boolean;
  finalGrade: ManiaGrade | null;
  finalHitTime: number | null;
}

type ScheduledEvent =
  | { type: 'key'; time: number; order: 0; event: ReplayKeyEvent }
  | { type: 'tap-deadline'; time: number; order: 1; objectId: number }
  | { type: 'hold-head-deadline'; time: number; order: 1; objectId: number }
  | { type: 'hold-tail-deadline'; time: number; order: 1; objectId: number };

function buildScheduledEvents(beatmap: PreparedBeatmap, replay: ReplayData): ScheduledEvent[] {
  const windows = getStableWindows(beatmap.overallDifficulty, replay.header.isScoreV2);
  const tailWindows = replay.header.isScoreV2 ? scaleWindows(windows, 1.5) : windows;
  const events: ScheduledEvent[] = replay.keyEvents.map((event) => ({
    type: 'key',
    time: event.time,
    order: 0,
    event,
  }));
  for (const object of beatmap.hitObjects) {
    if (!object.isHold) {
      events.push({
        type: 'tap-deadline',
        time: object.startTime + windows.miss,
        order: 1,
        objectId: object.id,
      });
      continue;
    }
    events.push({
      type: 'hold-head-deadline',
      time: object.startTime + windows.miss,
      order: 1,
      objectId: object.id,
    });
    events.push({
      type: 'hold-tail-deadline',
      time: object.endTime + tailWindows.miss,
      order: 1,
      objectId: object.id,
    });
  }
  events.sort((a, b) => a.time - b.time || a.order - b.order);
  return events;
}

function buildInitialHoldStates(beatmap: PreparedBeatmap): Record<number, InternalHoldState> {
  return beatmap.hitObjects
    .filter((object) => object.isHold)
    .reduce<Record<number, InternalHoldState>>((acc, object) => {
      acc[object.id] = {
        objectId: object.id,
        col: object.col,
        startTime: object.startTime,
        endTime: object.endTime,
        headResolved: false,
        headGrade: null,
        headHitTime: null,
        holding: false,
        bodyBrokenAt: null,
        tailResolved: false,
        tailGrade: null,
        tailHitTime: null,
        finalResolved: false,
        finalGrade: null,
        finalHitTime: null,
      };
      return acc;
    }, {});
}

function makeHoldResolution(state: InternalHoldState, scoreV2: boolean): HoldResolution {
  return {
    kind: 'hold',
    objectId: state.objectId,
    col: state.col,
    startTime: state.startTime,
    endTime: state.endTime,
    scoreV2,
    headResolvedAt: state.headHitTime,
    headGrade: state.headGrade,
    headHitTime: state.headHitTime,
    bodyBrokenAt: state.bodyBrokenAt,
    tailResolvedAt: state.tailHitTime,
    tailGrade: state.tailGrade,
    tailHitTime: state.tailHitTime,
    finalResolvedAt: state.finalHitTime,
    finalGrade: state.finalGrade,
    finalHitTime: state.finalHitTime,
  };
}

function scoreStateFromEvents(events: JudgementEvent[]): ScoreState {
  return events.length > 0 ? cloneScoreState(events[events.length - 1].scoreState) : cloneScoreState();
}

function hasResolvedAt(time: number, resolvedAt: number | null): boolean {
  return resolvedAt != null && time >= resolvedAt;
}

function interpolateLife(points: LifeGraphPoint[], time: number): number | null {
  if (points.length === 0) return null;
  if (time <= points[0].time) return points[0].value;
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    if (time > current.time) continue;
    if (current.time === previous.time) return current.value;
    const t = (time - previous.time) / (current.time - previous.time);
    return previous.value + (current.value - previous.value) * t;
  }
  return points[points.length - 1].value;
}

export function buildReplayTimeline(
  beatmapFile: BeatmapFile,
  replay: ReplayData,
  options: ReplayBuildOptions = {},
): ReplayTimeline {
  if (beatmapFile.mode !== 3) {
    throw new Error('Only native osu!mania beatmaps are supported.');
  }
  if (beatmapFile.rawMd5 !== replay.header.beatmapMD5) {
    throw new Error('The loaded .osu file does not match the replay beatmap MD5.');
  }

  const beatmap = prepareBeatmapForReplay(beatmapFile, replay.header.clockRate, replay.header.isMirror, replay.header.isScoreV2);
  const windows = getStableWindows(beatmap.overallDifficulty, replay.header.isScoreV2);
  const tapResolutions: Record<number, TapResolution> = {};
  const holdStates = buildInitialHoldStates(beatmap);
  const scheduledEvents = buildScheduledEvents(beatmap, replay);
  const judgements: JudgementEvent[] = [];
  const sampleEvents: HitsoundEvent[] = [];
  const accumulator = createScoreAccumulator(beatmap.totalJudgementUnits);
  const objectsByColumn = Array.from({ length: beatmap.keyCount }, (_, col) =>
    beatmap.hitObjects.filter((object) => object.col === col).sort((a, b) => a.startTime - b.startTime || a.id - b.id),
  );
  const pendingIndex = Array.from({ length: beatmap.keyCount }, () => 0);
  const activeHoldByColumn = Array.from({ length: beatmap.keyCount }, () => null as number | null);

  const pushJudgement = (objectId: number, part: JudgementEvent['part'], grade: ManiaGrade, hitTime: number, targetTime: number, col: number) => {
    const scoreState = applyJudgement(accumulator, replay.header, grade);
    judgements.push({
      objectId,
      part,
      col,
      time: hitTime,
      hitTime,
      targetTime,
      grade,
      delta: hitTime - targetTime,
      scoreState,
    });
  };

  const pushSampleEvent = (objectId: number, part: HitsoundEvent['part'], time: number) => {
    const object = beatmap.hitObjects[objectId];
    sampleEvents.push({
      time,
      objectId,
      part,
      layers: resolveHitsoundLayers(beatmap, object, part, time),
    });
  };

  const currentObjectForColumn = (col: number) => {
    const objects = objectsByColumn[col];
    let index = pendingIndex[col];
    while (index < objects.length) {
      const object = objects[index];
      if (!object.isHold && tapResolutions[object.id]) {
        index += 1;
        continue;
      }
      if (object.isHold && holdStates[object.id].finalResolved) {
        index += 1;
        continue;
      }
      break;
    }
    pendingIndex[col] = index;
    return objects[index] ?? null;
  };

  for (const scheduled of scheduledEvents) {
    if (scheduled.type === 'key') {
      const event = scheduled.event;
      const activeHoldId = activeHoldByColumn[event.col];
      if (!event.pressed && activeHoldId != null) {
        const hold = holdStates[activeHoldId];
        if (!hold.tailResolved) {
          const tailWindows = replay.header.isScoreV2 ? scaleWindows(windows, 1.5) : windows;
          if (event.time < hold.endTime - tailWindows.meh) {
            hold.holding = false;
            hold.bodyBrokenAt ??= event.time;
          } else {
            const tailDelta = event.time - hold.endTime;
            if (replay.header.isScoreV2) {
              let tailGrade = judgeAsymmetricTap(tailDelta, tailWindows);
              if (hold.bodyBrokenAt != null && tailGrade !== 'miss' && tailGrade !== 50) {
                tailGrade = 50;
              }
              hold.holding = false;
              hold.tailResolved = true;
              hold.tailGrade = tailGrade;
              hold.tailHitTime = event.time;
              hold.finalResolved = true;
              hold.finalGrade = tailGrade;
              hold.finalHitTime = event.time;
              activeHoldByColumn[event.col] = null;
              pushJudgement(hold.objectId, 'tail', tailGrade, event.time, hold.endTime, hold.col);
              if (tailGrade !== 'miss') pushSampleEvent(hold.objectId, 'tail', event.time);
            } else {
              const finalGrade = judgeScoreV1Hold(
                (hold.headHitTime ?? hold.startTime + windows.miss) - hold.startTime,
                tailDelta,
                hold.bodyBrokenAt != null,
                windows,
              );
              hold.holding = false;
              hold.tailResolved = true;
              hold.tailGrade = finalGrade;
              hold.tailHitTime = event.time;
              hold.finalResolved = true;
              hold.finalGrade = finalGrade;
              hold.finalHitTime = event.time;
              activeHoldByColumn[event.col] = null;
              pushJudgement(hold.objectId, 'hold', finalGrade, event.time, hold.endTime, hold.col);
              if (finalGrade !== 'miss') pushSampleEvent(hold.objectId, 'tail', event.time);
            }
          }
        }
      }

      if (event.pressed) {
        const current = currentObjectForColumn(event.col);
        if (current && event.time >= current.startTime - windows.miss && event.time <= current.startTime + windows.miss) {
          if (!current.isHold) {
            const grade = judgeTap(event.time - current.startTime, windows);
            tapResolutions[current.id] = {
              kind: 'tap',
              objectId: current.id,
              col: current.col,
              targetTime: current.startTime,
              resolvedAt: event.time,
              grade,
              hitTime: event.time,
            };
            if (grade !== 'miss') {
              pushJudgement(current.id, 'tap', grade, event.time, current.startTime, current.col);
              pushSampleEvent(current.id, 'tap', event.time);
              pendingIndex[event.col] += 1;
            }
          } else {
            const hold = holdStates[current.id];
            if (!hold.headResolved) {
              const grade = judgeTap(event.time - current.startTime, windows);
              hold.headResolved = true;
              hold.headGrade = grade;
              hold.headHitTime = event.time;
              hold.holding = grade !== 'miss';
              if (grade === 'miss') {
                hold.bodyBrokenAt ??= event.time;
                // ScoreV1: do NOT resolve the hold here — let hold-tail-deadline fire
                // so tail judgement is applied and pendingIndex advances exactly once.
              } else {
                activeHoldByColumn[event.col] = current.id;
                pushSampleEvent(current.id, 'head', event.time);
              }
              if (replay.header.isScoreV2) {
                pushJudgement(current.id, 'head', grade, event.time, current.startTime, current.col);
              }
            } else if (!hold.holding) {
              hold.holding = true;
            }
          }
        } else if (activeHoldId != null) {
          holdStates[activeHoldId].holding = true;
        }
      }
      continue;
    }

    if (scheduled.type === 'tap-deadline') {
      const object = beatmap.hitObjects[scheduled.objectId];
      if (!tapResolutions[scheduled.objectId]) {
        tapResolutions[scheduled.objectId] = {
          kind: 'tap',
          objectId: object.id,
          col: object.col,
          targetTime: object.startTime,
          resolvedAt: scheduled.time,
          grade: 'miss',
          hitTime: scheduled.time,
        };
        pushJudgement(object.id, 'tap', 'miss', scheduled.time, object.startTime, object.col);
        pendingIndex[object.col] += 1;
      }
      continue;
    }

    if (scheduled.type === 'hold-head-deadline') {
      const hold = holdStates[scheduled.objectId];
      if (!hold.headResolved) {
        hold.headResolved = true;
        hold.headGrade = 'miss';
        hold.headHitTime = scheduled.time;
        hold.bodyBrokenAt = scheduled.time;
        if (replay.header.isScoreV2) {
          pushJudgement(hold.objectId, 'head', 'miss', scheduled.time, hold.startTime, hold.col);
        } else {
          // Mark head as missed but do NOT finalize or advance pendingIndex here.
          // hold-tail-deadline will fire later, see headGrade === 'miss', emit the
          // final miss judgement, and advance pendingIndex exactly once.
        }
      }
      continue;
    }

    const hold = holdStates[scheduled.objectId];
    if (hold.finalResolved) {
      // Already resolved when the key was released — pendingIndex was advanced then.
      // Just clear the active hold slot; do NOT advance pendingIndex again.
      activeHoldByColumn[hold.col] = null;
      continue;
    }

    if (replay.header.isScoreV2) {
      if (!hold.tailResolved) {
        hold.holding = false;
        hold.tailResolved = true;
        hold.tailGrade = 'miss';
        hold.tailHitTime = scheduled.time;
        hold.finalResolved = true;
        hold.finalGrade = 'miss';
        hold.finalHitTime = scheduled.time;
        pushJudgement(hold.objectId, 'tail', 'miss', scheduled.time, hold.endTime, hold.col);
        pendingIndex[hold.col] += 1;
        activeHoldByColumn[hold.col] = null;
      }
    } else {
      const headDelta = (hold.headHitTime ?? hold.startTime + windows.miss) - hold.startTime;
      const tailDelta = scheduled.time - hold.endTime;
      const finalGrade =
        hold.headGrade === 'miss'
          ? 'miss'
          : judgeScoreV1Hold(headDelta, tailDelta, hold.bodyBrokenAt != null || !hold.holding, windows);
      hold.holding = false;
      hold.tailResolved = true;
      hold.tailGrade = finalGrade;
      hold.tailHitTime = scheduled.time;
      hold.finalResolved = true;
      hold.finalGrade = finalGrade;
      hold.finalHitTime = scheduled.time;
      pushJudgement(hold.objectId, 'hold', finalGrade, scheduled.time, hold.endTime, hold.col);
      pendingIndex[hold.col] += 1;
      activeHoldByColumn[hold.col] = null;
    }
  }

  const holdResolutions = Object.fromEntries(
    Object.values(holdStates).map((hold) => [hold.objectId, makeHoldResolution(hold, replay.header.isScoreV2)]),
  ) as Record<number, HoldResolution>;

  const finalScore = scoreStateFromEvents(judgements);
  const countsMatch =
    finalScore.counts['300'] === replay.header.count300 &&
    finalScore.counts['100'] === replay.header.count100 &&
    finalScore.counts['50'] === replay.header.count50 &&
    finalScore.counts['320'] === replay.header.countGeki &&
    finalScore.counts['200'] === replay.header.countKatu &&
    finalScore.counts.miss === replay.header.countMiss;
  const scoreMatch = Math.round(finalScore.score) === replay.header.totalScore;
  const maxComboMatch = finalScore.maxCombo === replay.header.maxCombo;
  const accuracyHeader = replay.header.isScoreV2
    ? (
        (replay.header.countGeki * 305 +
          replay.header.count300 * 300 +
          replay.header.countKatu * 200 +
          replay.header.count100 * 100 +
          replay.header.count50 * 50) /
        Math.max(
          1,
          (replay.header.countGeki +
            replay.header.count300 +
            replay.header.countKatu +
            replay.header.count100 +
            replay.header.count50 +
            replay.header.countMiss) *
            305,
        )
      )
    : (
        (replay.header.countGeki * 300 +
          replay.header.count300 * 300 +
          replay.header.countKatu * 200 +
          replay.header.count100 * 100 +
          replay.header.count50 * 50) /
        Math.max(
          1,
          (replay.header.countGeki +
            replay.header.count300 +
            replay.header.countKatu +
            replay.header.count100 +
            replay.header.count50 +
            replay.header.countMiss) *
            300,
        )
      );
  const accuracyMatch = Math.abs(finalScore.accuracy - accuracyHeader) < 0.0001;
  const messages: string[] = [];
  if (!countsMatch) messages.push('Judgement counts do not match replay header.');
  if (!scoreMatch) messages.push('Score does not match replay header.');
  if (!maxComboMatch) messages.push('Max combo does not match replay header.');
  if (!accuracyMatch) messages.push('Accuracy does not match replay header.');

  let lifeGraphDrift: number | null = null;
  if (options.validateLifeGraph && replay.header.lifeGraph.length > 0) {
    lifeGraphDrift = replay.header.lifeGraph.reduce((maxDrift, point) => {
      const sampled = interpolateLife(replay.header.lifeGraph, point.time);
      return Math.max(maxDrift, Math.abs((sampled ?? point.value) - point.value));
    }, 0);
  }

  return {
    beatmap,
    replay,
    judgements,
    tapResolutions,
    holdResolutions,
    columnEvents: Array.from({ length: beatmap.keyCount }, (_, col) => replay.keyEvents.filter((event) => event.col === col)),
    sampleEvents,
    lifeGraph: replay.header.lifeGraph,
    finalScore,
    validation: {
      countsMatch,
      scoreMatch,
      maxComboMatch,
      accuracyMatch,
      lifeGraphDrift,
      messages,
    },
  };
}

function scoreAtTime(timeline: ReplayTimeline, time: number): ScoreState {
  const index = lowerBound(timeline.judgements, time, (event) => event.time) - 1;
  if (index < 0) return cloneScoreState();
  return cloneScoreState(timeline.judgements[index].scoreState);
}

function keyStatesAtTime(timeline: ReplayTimeline, time: number): boolean[] {
  return timeline.columnEvents.map((events) => {
    const index = lowerBound(events, time, (event) => event.time) - 1;
    return index >= 0 ? events[index].pressed : false;
  });
}

export function getSnapshotAt(timeline: ReplayTimeline, time: number): FrameSnapshot {
  const judgementIndex = lowerBound(timeline.judgements, time, (event) => event.time) - 1;
  const latest = judgementIndex >= 0 ? timeline.judgements[judgementIndex] : null;
  const tapStates = Object.fromEntries(
    Object.entries(timeline.tapResolutions).map(([id, resolution]) => [
      Number(id),
      {
        visible: !(resolution.resolvedAt <= time),
        resolved: resolution.resolvedAt <= time,
        resolvedAt: resolution.resolvedAt,
        grade: resolution.resolvedAt <= time ? resolution.grade : null,
      },
    ]),
  ) as FrameSnapshot['tapStates'];
  const holdStates = Object.fromEntries(
    Object.entries(timeline.holdResolutions).map(([id, resolution]) => {
      const headResolved = hasResolvedAt(time, resolution.headResolvedAt);
      const tailResolved = hasResolvedAt(time, resolution.tailResolvedAt);
      const finalResolved = hasResolvedAt(time, resolution.finalResolvedAt);
      const bodyBroken = hasResolvedAt(time, resolution.bodyBrokenAt);
      const holding =
        headResolved &&
        resolution.headGrade != null &&
        resolution.headGrade !== 'miss' &&
        time >= resolution.startTime &&
        !bodyBroken &&
        !finalResolved;
      let anchorTime = resolution.startTime;
      if (holding) {
        anchorTime = time;
      } else if (bodyBroken && resolution.bodyBrokenAt != null) {
        anchorTime = resolution.bodyBrokenAt;
      }
      return [
        Number(id),
        {
          visible: !finalResolved,
          headResolved,
          headGrade: headResolved ? resolution.headGrade : null,
          tailResolved,
          tailGrade: tailResolved ? resolution.tailGrade : null,
          finalResolved,
          finalGrade: finalResolved ? resolution.finalGrade : null,
          holding,
          bodyBroken,
          bodyBrokenAt: bodyBroken ? resolution.bodyBrokenAt : null,
          headResolvedAt: resolution.headResolvedAt,
          tailResolvedAt: resolution.tailResolvedAt,
          finalResolvedAt: resolution.finalResolvedAt,
          anchorTime,
        },
      ];
    }),
  ) as FrameSnapshot['holdStates'];
  return {
    time,
    keyStates: keyStatesAtTime(timeline, time),
    score: scoreAtTime(timeline, time),
    life: interpolateLife(timeline.lifeGraph, time),
    latestJudgement:
      latest && time - latest.time <= 700
        ? {
            time: latest.time,
            grade: latest.grade,
            col: latest.col,
          }
        : null,
    tapStates,
    holdStates,
  };
}

// ─── Zero-allocation sequential frame cursor for fast export rendering ────────
//
// Instead of pre-building a snapshot table (which allocates N×objects records),
// we create ONE mutable snapshot object and advance it frame-by-frame in O(1)
// amortised time. The render loop reads from it directly; no objects are created
// inside the hot path.

export interface MutableSnapshot {
  time: number;
  keyStates: boolean[];                         // mutated in place each frame
  score: import('./types').ScoreState;          // mutated in place each frame
  life: number | null;
  latestJudgement: import('./types').JudgementFlash | null;
  tapStates: FrameSnapshot['tapStates'];        // per-object entries mutated in place
  holdStates: FrameSnapshot['holdStates'];      // per-object entries mutated in place
}

export interface FrameCursor {
  /** Advance to the next frame time and update the snapshot in place. */
  advance(): void;
  /** The current snapshot — valid after each advance() call. Do not store across frames. */
  readonly snapshot: MutableSnapshot;
  /** Current frame index. */
  frameIndex: number;
}

export function createFrameCursor(
  timeline: ReplayTimeline,
  totalFrames: number,
  frameDurationMs: number,
  leadInMs: number,
): FrameCursor {
  const { tapResolutions, holdResolutions, columnEvents, judgements, lifeGraph } = timeline;

  const tapIds   = Object.keys(tapResolutions).map(Number);
  const holdIds  = Object.keys(holdResolutions).map(Number);
  const keyCount = columnEvents.length;

  // ── Cursors — advanced monotonically, never reset ──
  const colCursors     = new Int32Array(keyCount);   // typed array: no GC
  let   judgeCursor    = 0;
  let   scoreCursor    = 0;
  let   lifeCursor     = 0;

  // ── Pre-allocate the ONE snapshot object and all its nested structures ──
  const keyStates: boolean[] = new Array(keyCount).fill(false);

  const score: import('./types').ScoreState = {
    score: 0, combo: 0, maxCombo: 0, accuracy: 1,
    counts: { '320': 0, '300': 0, '200': 0, '100': 0, '50': 0, miss: 0 },
  };

  // Pre-allocate one tap-state object per tap note
  const tapStates: FrameSnapshot['tapStates'] = {};
  for (const id of tapIds) {
    tapStates[id] = { visible: true, resolved: false, resolvedAt: null, grade: null };
  }

  // Pre-allocate one hold-state object per hold note
  const holdStates: FrameSnapshot['holdStates'] = {};
  for (const id of holdIds) {
    const r = holdResolutions[id];
    holdStates[id] = {
      visible: true,
      headResolved: false, headGrade: null,
      tailResolved: false, tailGrade: null,
      finalResolved: false, finalGrade: null,
      holding: false, bodyBroken: false,
      bodyBrokenAt: null,
      headResolvedAt: r.headResolvedAt,
      tailResolvedAt: r.tailResolvedAt,
      finalResolvedAt: r.finalResolvedAt,
      anchorTime: r.startTime,
    };
  }

  const snapshot: MutableSnapshot = {
    time: -leadInMs,
    keyStates,
    score,
    life: null,
    latestJudgement: null,
    tapStates,
    holdStates,
  };

  let frameIndex = -1;

  function advance(): void {
    frameIndex++;
    const time = frameIndex * frameDurationMs - leadInMs;
    snapshot.time = time;

    // ── Key states ──
    for (let col = 0; col < keyCount; col++) {
      const events = columnEvents[col];
      while (colCursors[col] < events.length - 1 && events[colCursors[col] + 1].time <= time) {
        colCursors[col]++;
      }
      const idx = colCursors[col];
      keyStates[col] = idx < events.length ? events[idx].pressed : false;
    }

    // ── Score ──
    while (scoreCursor < judgements.length - 1 && judgements[scoreCursor + 1].time <= time) {
      scoreCursor++;
    }
    if (judgements.length > 0 && judgements[scoreCursor].time <= time) {
      const s = judgements[scoreCursor].scoreState;
      score.score    = s.score;
      score.combo    = s.combo;
      score.maxCombo = s.maxCombo;
      score.accuracy = s.accuracy;
      const c = s.counts;
      score.counts['320'] = c['320'];
      score.counts['300'] = c['300'];
      score.counts['200'] = c['200'];
      score.counts['100'] = c['100'];
      score.counts['50']  = c['50'];
      score.counts['miss'] = c['miss'];
    }

    // ── Latest judgement flash ──
    while (judgeCursor < judgements.length - 1 && judgements[judgeCursor + 1].time <= time) {
      judgeCursor++;
    }
    if (judgements.length > 0 && judgements[judgeCursor].time <= time) {
      const j = judgements[judgeCursor];
      if (time - j.time <= 700) {
        if (!snapshot.latestJudgement) {
          snapshot.latestJudgement = { time: j.time, grade: j.grade, col: j.col };
        } else {
          snapshot.latestJudgement.time  = j.time;
          snapshot.latestJudgement.grade = j.grade;
          snapshot.latestJudgement.col   = j.col;
        }
      } else {
        snapshot.latestJudgement = null;
      }
    } else {
      snapshot.latestJudgement = null;
    }

    // ── Life — simple linear interpolation with cursor ──
    if (lifeGraph.length > 0) {
      while (lifeCursor < lifeGraph.length - 1 && lifeGraph[lifeCursor + 1].time <= time) {
        lifeCursor++;
      }
      snapshot.life = interpolateLife(lifeGraph, time);
    }

    // ── Tap states — mutate in place ──
    for (const id of tapIds) {
      const r   = tapResolutions[id];
      const ts  = tapStates[id];
      const res = r.resolvedAt <= time;
      ts.visible    = !res;
      ts.resolved   = res;
      ts.resolvedAt = r.resolvedAt;
      ts.grade      = res ? r.grade : null;
    }

    // ── Hold states — mutate in place ──
    for (const id of holdIds) {
      const r   = holdResolutions[id];
      const hs  = holdStates[id];
      const headResolved  = hasResolvedAt(time, r.headResolvedAt);
      const tailResolved  = hasResolvedAt(time, r.tailResolvedAt);
      const finalResolved = hasResolvedAt(time, r.finalResolvedAt);
      const bodyBroken    = hasResolvedAt(time, r.bodyBrokenAt);
      const holding =
        headResolved &&
        r.headGrade != null &&
        r.headGrade !== 'miss' &&
        time >= r.startTime &&
        !bodyBroken &&
        !finalResolved;

      hs.headResolved  = headResolved;
      hs.headGrade     = headResolved  ? r.headGrade  : null;
      hs.tailResolved  = tailResolved;
      hs.tailGrade     = tailResolved  ? r.tailGrade  : null;
      hs.finalResolved = finalResolved;
      hs.finalGrade    = finalResolved ? r.finalGrade : null;
      hs.holding       = holding;
      hs.bodyBroken    = bodyBroken;
      hs.bodyBrokenAt  = bodyBroken ? r.bodyBrokenAt : null;
      hs.visible       = !finalResolved;
      hs.anchorTime    = holding
        ? time
        : (bodyBroken && r.bodyBrokenAt != null ? r.bodyBrokenAt : r.startTime);
    }
  }

  return {
    get snapshot() { return snapshot; },
    get frameIndex() { return frameIndex; },
    set frameIndex(v: number) { frameIndex = v; },
    advance,
  };
}
