export type ManiaGrade = 320 | 300 | 200 | 100 | 50 | 'miss';

export interface LifeGraphPoint {
  time: number;
  value: number;
}

export interface ManiaTimingPoint {
  time: number;
  beatLength: number;
  meter: number;
  uninherited: boolean;
  sampleSet: number;
  sampleIndex: number;
  volume: number;
  effects: number;
}

export interface ManiaHitObject {
  id: number;
  col: number;
  startTime: number;
  endTime: number;
  isHold: boolean;
  hitSound: number;
  sample: HitSampleInfo;
}

export interface HitSampleInfo {
  normalSet: number;
  additionSet: number;
  index: number;
  volume: number;
  filename: string;
}

export type HitsoundKind = 'normal' | 'whistle' | 'finish' | 'clap' | 'custom';

export interface HitsoundLayer {
  kind: HitsoundKind;
  sampleSet: number;
  index: number;
  volume: number;
  filename: string;
}

export interface HitsoundEvent {
  time: number;
  objectId: number;
  part: 'tap' | 'head' | 'tail' | 'hold';
  layers: HitsoundLayer[];
}

export interface BeatmapFile {
  rawText: string;
  rawMd5: string;
  mode: number;
  title: string;
  artist: string;
  version: string;
  audioFilename: string;
  bgFilename: string;
  keyCount: number;
  overallDifficulty: number;
  hpDrainRate: number;
  timingPoints: ManiaTimingPoint[];
  hitObjects: ManiaHitObject[];
}

export interface ScrollSegment {
  startTime: number;
  endTime: number;
  beatLength: number;
  sv: number;
  factor: number;
  scrollAtStart: number;
}

export interface PreparedBeatmap extends BeatmapFile {
  clockRate: number;
  isMirror: boolean;
  totalJudgementUnits: number;
  totalDuration: number;
  baseBeatLength: number;
  scrollSegments: ScrollSegment[];
}

export interface ReplayHeader {
  gameMode: number;
  gameVersion: number;
  beatmapMD5: string;
  playerName: string;
  replayMD5: string;
  count300: number;
  count100: number;
  count50: number;
  countGeki: number;
  countKatu: number;
  countMiss: number;
  totalScore: number;
  maxCombo: number;
  perfectCombo: boolean;
  mods: number;
  modNames: string[];
  lifeGraph: LifeGraphPoint[];
  timestamp: number;
  compressedLen: number;
  compressedOffset: number;
  rawOk: boolean;
  clockRate: number;
  isDoubleTime: boolean;
  isHalfTime: boolean;
  isMirror: boolean;
  isScoreV2: boolean;
}

export interface ReplayFrame {
  time: number;
  x: number;
  y: number;
  z: number;
  keyMask: number;
}

export interface ReplayKeyEvent {
  time: number;
  col: number;
  pressed: boolean;
  keyMask: number;
}

export interface ReplayData {
  header: ReplayHeader;
  frames: ReplayFrame[];
  keyEvents: ReplayKeyEvent[];
}

export interface ScoreState {
  score: number;
  combo: number;
  maxCombo: number;
  accuracy: number;
  counts: Record<'320' | '300' | '200' | '100' | '50' | 'miss', number>;
}

export interface JudgementEvent {
  objectId: number;
  part: 'tap' | 'head' | 'tail' | 'hold';
  col: number;
  time: number;
  hitTime: number;
  targetTime: number;
  grade: ManiaGrade;
  delta: number;
  scoreState: ScoreState;
}

export interface TapResolution {
  kind: 'tap';
  objectId: number;
  col: number;
  targetTime: number;
  resolvedAt: number;
  grade: ManiaGrade;
  hitTime: number;
}

export interface HoldResolution {
  kind: 'hold';
  objectId: number;
  col: number;
  startTime: number;
  endTime: number;
  scoreV2: boolean;
  headResolvedAt: number | null;
  headGrade: ManiaGrade | null;
  headHitTime: number | null;
  bodyBrokenAt: number | null;
  tailResolvedAt: number | null;
  tailGrade: ManiaGrade | null;
  tailHitTime: number | null;
  finalResolvedAt: number | null;
  finalGrade: ManiaGrade | null;
  finalHitTime: number | null;
}

export interface ReplayValidation {
  countsMatch: boolean;
  scoreMatch: boolean;
  maxComboMatch: boolean;
  accuracyMatch: boolean;
  lifeGraphDrift: number | null;
  messages: string[];
}

export interface ReplayTimeline {
  beatmap: PreparedBeatmap;
  replay: ReplayData;
  judgements: JudgementEvent[];
  tapResolutions: Record<number, TapResolution>;
  holdResolutions: Record<number, HoldResolution>;
  columnEvents: ReplayKeyEvent[][];
  sampleEvents: HitsoundEvent[];
  lifeGraph: LifeGraphPoint[];
  finalScore: ScoreState;
  validation: ReplayValidation;
}

export interface ReplayBuildOptions {
  validateLifeGraph?: boolean;
}

export interface JudgementFlash {
  time: number;
  grade: ManiaGrade;
  col: number;
}

export interface FrameSnapshot {
  time: number;
  keyStates: boolean[];
  score: ScoreState;
  life: number | null;
  latestJudgement: JudgementFlash | null;
  tapStates: Record<
    number,
    {
      visible: boolean;
      resolved: boolean;
      resolvedAt: number | null;
      grade: ManiaGrade | null;
    }
  >;
  holdStates: Record<
    number,
    {
      visible: boolean;
      headResolved: boolean;
      headGrade: ManiaGrade | null;
      tailResolved: boolean;
      tailGrade: ManiaGrade | null;
      finalResolved: boolean;
      finalGrade: ManiaGrade | null;
      holding: boolean;
      bodyBroken: boolean;
      bodyBrokenAt: number | null;
      headResolvedAt: number | null;
      tailResolvedAt: number | null;
      finalResolvedAt: number | null;
      anchorTime: number;
    }
  >;
}

export interface RenderHudAnchor {
  anchor: 'tl' | 'tc' | 'tr' | 'ml' | 'mc' | 'mr' | 'bl' | 'bc' | 'br';
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface RenderSettings {
  scrollSpeed: number;
  hitPosition: number;
  laneWidth: number;
  laneGap: number;
  laneBorderWidth: number;
  laneBorderColor: string;
  laneColor: string;
  judgeLineOpacity: number;
  playFieldOpacity: number;
  dimBg: number;
  motionBlur: boolean;
  motionBlurSamples: number;
  motionBlurStrength: number;
  exportShutterSamples: number;
  showKeypress: boolean;
  customFont: string | null;
  hudScore: RenderHudAnchor;
  hudCombo: RenderHudAnchor;
  hudAcc: RenderHudAnchor;
  hudJudge: RenderHudAnchor;
  // Visibility toggles
  showHudScore: boolean;
  showHudAcc: boolean;
  showHudCombo: boolean;
  showHudJudge: boolean;
  showReceptors: boolean;
  showLanes: boolean;
  showJudgeLine: boolean;
}

export interface ExportJobOptions {
  osuPath: string;
  osrPath: string;
  audioPath?: string;
  bgPath?: string;
  skinDir?: string;
  fontPath?: string;
  settingsPath?: string;
  width: number;
  height: number;
  fps: number;
  leadInMs: number;
  tailPadMs: number;
  outPath: string;
}
