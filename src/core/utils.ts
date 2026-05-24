import SparkMD5 from 'spark-md5';
import type { ManiaGrade, ScoreState } from './types';

export const EMPTY_COUNTS: ScoreState['counts'] = {
  '320': 0,
  '300': 0,
  '200': 0,
  '100': 0,
  '50': 0,
  miss: 0,
};

export function cloneScoreState(state?: Partial<ScoreState>): ScoreState {
  return {
    score: state?.score ?? 0,
    combo: state?.combo ?? 0,
    maxCombo: state?.maxCombo ?? 0,
    accuracy: state?.accuracy ?? 1,
    counts: {
      ...EMPTY_COUNTS,
      ...(state?.counts ?? {}),
    },
  };
}

export function md5Hex(bytes: Uint8Array): string {
  return SparkMD5.ArrayBuffer.hash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export function lowerBound<T>(items: readonly T[], needle: number, getter: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (getter(items[mid]) <= needle) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function roundStableError(delta: number): number {
  return Math.round(Math.abs(delta));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function gradeKey(grade: ManiaGrade): keyof ScoreState['counts'] {
  return String(grade) as keyof ScoreState['counts'];
}

export function weightForAccuracy(grade: ManiaGrade, scoreV2: boolean): number {
  switch (grade) {
    case 320:
      return scoreV2 ? 305 : 300;
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
