import { scoreV1BonusDivider, scoreV1ModMultiplier } from './mods';
import { cloneScoreState, gradeKey, roundStableError, weightForAccuracy, clamp } from './utils';
import type { ManiaGrade, ReplayHeader, ScoreState } from './types';

export interface ManiaWindows {
  perfect: number;
  great: number;
  good: number;
  ok: number;
  meh: number;
  miss: number;
}

const SCORE_V1_VALUES: Record<'320' | '300' | '200' | '100' | '50' | 'miss', { hitValue: number; bonusValue: number; bonusDelta: number; punishment: number }> = {
  '320': { hitValue: 320, bonusValue: 32, bonusDelta: 2, punishment: 0 },
  '300': { hitValue: 300, bonusValue: 32, bonusDelta: 1, punishment: 0 },
  '200': { hitValue: 200, bonusValue: 16, bonusDelta: 0, punishment: 8 },
  '100': { hitValue: 100, bonusValue: 8, bonusDelta: 0, punishment: 24 },
  '50': { hitValue: 50, bonusValue: 4, bonusDelta: 0, punishment: 44 },
  miss: { hitValue: 0, bonusValue: 0, bonusDelta: 0, punishment: Number.POSITIVE_INFINITY },
};

export function getStableWindows(od: number, scoreV2: boolean): ManiaWindows {
  if (scoreV2) {
    const perfect = od <= 5 ? 22.4 - 0.6 * od : 24.9 - 1.1 * od;
    return {
      perfect,
      great: 64 - 3 * od,
      good: 97 - 3 * od,
      ok: 127 - 3 * od,
      meh: 151 - 3 * od,
      miss: 188 - 3 * od,
    };
  }
  return {
    perfect: 16,
    great: 64 - 3 * od,
    good: 97 - 3 * od,
    ok: 127 - 3 * od,
    meh: 151 - 3 * od,
    miss: 188 - 3 * od,
  };
}

export function judgeTap(delta: number, windows: ManiaWindows): ManiaGrade {
  const error = roundStableError(delta);
  if (error <= Math.floor(windows.perfect)) return 320;
  if (error <= Math.floor(windows.great)) return 300;
  if (error <= Math.floor(windows.good)) return 200;
  if (error <= Math.floor(windows.ok)) return 100;
  if (error <= Math.floor(windows.meh)) return 50;
  return 'miss';
}

export function judgeAsymmetricTap(delta: number, windows: ManiaWindows): ManiaGrade {
  const error = roundStableError(delta);
  if (delta > Math.floor(windows.ok) || delta < -Math.floor(windows.meh)) return 'miss';
  if (error <= Math.floor(windows.perfect)) return 320;
  if (error <= Math.floor(windows.great)) return 300;
  if (error <= Math.floor(windows.good)) return 200;
  if (error <= Math.floor(windows.ok)) return 100;
  if (delta < 0 && error <= Math.floor(windows.meh)) return 50;
  return 'miss';
}

export function scaleWindows(windows: ManiaWindows, factor: number): ManiaWindows {
  return {
    perfect: windows.perfect * factor,
    great: windows.great * factor,
    good: windows.good * factor,
    ok: windows.ok * factor,
    meh: windows.meh * factor,
    miss: windows.miss * factor,
  };
}

export function judgeScoreV1Hold(headDelta: number, tailDelta: number, bodyBroken: boolean, windows: ManiaWindows): ManiaGrade {
  const headError = roundStableError(headDelta);
  const tailError = roundStableError(tailDelta);
  const combined = headError + tailError;
  if (!bodyBroken && headError <= Math.floor(windows.perfect * 1.2) && combined <= Math.floor(windows.perfect * 2.4)) {
    return 320;
  }
  if (!bodyBroken && headError <= Math.floor(windows.great * 1.1) && combined <= Math.floor(windows.great * 2.2)) {
    return 300;
  }
  if (!bodyBroken && headError <= Math.floor(windows.good) && combined <= Math.floor(windows.good * 2)) {
    return 200;
  }
  if (!bodyBroken && headError <= Math.floor(windows.ok) && combined <= Math.floor(windows.ok * 2)) {
    return 100;
  }
  return tailError <= Math.floor(windows.miss) ? 50 : 'miss';
}

function scoreV2ComboFactor(comboAfter: number): number {
  const raw = Math.log(Math.max(1, comboAfter)) / Math.log(4);
  return Math.min(Math.max(0.5, raw), Math.log(400) / Math.log(4));
}

function gradeBaseScore(grade: ManiaGrade): number {
  switch (grade) {
    case 320:
      return 305;
    case 300:
      return 300;
    case 200:
      return 200;
    case 100:
      return 100;
    case 50:
      return 50;
    default:
      return 0;
  }
}

function comboBaseScore(grade: ManiaGrade): number {
  return grade === 320 ? 300 : gradeBaseScore(grade);
}

export interface ScoreAccumulator {
  state: ScoreState;
  totalJudgementUnits: number;
  scoreV1Bonus: number;
  scoreV2ComboScore: number;
  scoreV2MaxComboScore: number;
  judgedUnits: number;
}

export function createScoreAccumulator(totalJudgementUnits: number): ScoreAccumulator {
  return {
    state: cloneScoreState(),
    totalJudgementUnits,
    scoreV1Bonus: 100,
    scoreV2ComboScore: 0,
    scoreV2MaxComboScore: 0,
    judgedUnits: 0,
  };
}

function computeAccuracy(counts: ScoreState['counts'], scoreV2: boolean): number {
  const total = counts['320'] + counts['300'] + counts['200'] + counts['100'] + counts['50'] + counts.miss;
  if (total === 0) return 1;
  const weighted =
    counts['320'] * weightForAccuracy(320, scoreV2) +
    counts['300'] * 300 +
    counts['200'] * 200 +
    counts['100'] * 100 +
    counts['50'] * 50;
  const max = total * (scoreV2 ? 305 : 300);
  return clamp(weighted / max, 0, 1);
}

function applyScoreV1(accumulator: ScoreAccumulator, header: ReplayHeader, grade: ManiaGrade): void {
  const state = accumulator.state;
  const totalNotes = accumulator.totalJudgementUnits;
  const key = gradeKey(grade);
  const values = SCORE_V1_VALUES[key];
  const multiplier = scoreV1ModMultiplier(header.mods);
  const divider = scoreV1BonusDivider(header.mods);
  const unit = (1000000 * multiplier * 0.5) / totalNotes;

  if (grade === 'miss') {
    state.combo = 0;
    accumulator.scoreV1Bonus = 0;
  } else {
    state.combo += 1;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
  }

  state.counts[key] += 1;
  const bonusBefore = accumulator.scoreV1Bonus;
  const baseScore = unit * (values.hitValue / 320);
  const bonusScore = unit * (values.bonusValue * Math.sqrt(bonusBefore) / 320);
  state.score += baseScore + bonusScore;

  if (values.punishment === Number.POSITIVE_INFINITY) {
    accumulator.scoreV1Bonus = 0;
  } else {
    accumulator.scoreV1Bonus = clamp(bonusBefore + values.bonusDelta - values.punishment / divider, 0, 100);
  }

  accumulator.judgedUnits += 1;
  state.accuracy = computeAccuracy(state.counts, false);
}

function applyScoreV2(accumulator: ScoreAccumulator, grade: ManiaGrade): void {
  const state = accumulator.state;
  const key = gradeKey(grade);
  if (grade === 'miss') {
    state.combo = 0;
  } else {
    state.combo += 1;
    state.maxCombo = Math.max(state.maxCombo, state.combo);
  }

  state.counts[key] += 1;
  accumulator.judgedUnits += 1;
  state.accuracy = computeAccuracy(state.counts, true);

  const comboFactor = scoreV2ComboFactor(state.combo || 1);
  accumulator.scoreV2ComboScore += comboBaseScore(grade) * comboFactor;
  accumulator.scoreV2MaxComboScore += 300 * scoreV2ComboFactor(accumulator.judgedUnits);

  const comboProgress = accumulator.scoreV2MaxComboScore > 0 ? accumulator.scoreV2ComboScore / accumulator.scoreV2MaxComboScore : 0;
  const accuracyProgress = accumulator.judgedUnits / accumulator.totalJudgementUnits;
  state.score =
    150000 * comboProgress +
    850000 * Math.pow(state.accuracy, 2 + 2 * state.accuracy) * accuracyProgress;
}

export function applyJudgement(accumulator: ScoreAccumulator, header: ReplayHeader, grade: ManiaGrade): ScoreState {
  if (header.isScoreV2) {
    applyScoreV2(accumulator, grade);
  } else {
    applyScoreV1(accumulator, header, grade);
  }
  return cloneScoreState(accumulator.state);
}
