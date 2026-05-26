import type { RenderSettings } from '../core';

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  scrollSpeed: 20,
  hitPosition: 0.88,
  laneWidth: 70,
  laneGap: 2,
  laneBorderWidth: 1,
  laneBorderColor: 'rgba(255,255,255,0.12)',
  laneColor: 'rgba(255,255,255,0.03)',
  judgeLineOpacity: 0.6,
  playFieldOpacity: 1,
  dimBg: 0.5,
  motionBlur: false,
  motionBlurSamples: 5,
  motionBlurStrength: 0.35,
  exportShutterSamples: 1,
  showKeypress: true,
  customFont: null,
  hudScore: { anchor: 'tr', offsetX: -18, offsetY: 42, scale: 1 },
  hudCombo: { anchor: 'bc', offsetX: 0, offsetY: -110, scale: 1 },
  hudAcc: { anchor: 'tl', offsetX: 18, offsetY: 42, scale: 1 },
  hudJudge: { anchor: 'bc', offsetX: 0, offsetY: -80, scale: 1 },
  showHudScore: true,
  showHudAcc: true,
  showHudCombo: true,
  showHudJudge: true,
  showReceptors: true,
  showLanes: true,
  showJudgeLine: true,
};

export function mergeRenderSettings(partial?: Partial<RenderSettings>): RenderSettings {
  return {
    ...DEFAULT_RENDER_SETTINGS,
    ...(partial ?? {}),
    hudScore: { ...DEFAULT_RENDER_SETTINGS.hudScore, ...(partial?.hudScore ?? {}) },
    hudCombo: { ...DEFAULT_RENDER_SETTINGS.hudCombo, ...(partial?.hudCombo ?? {}) },
    hudAcc: { ...DEFAULT_RENDER_SETTINGS.hudAcc, ...(partial?.hudAcc ?? {}) },
    hudJudge: { ...DEFAULT_RENDER_SETTINGS.hudJudge, ...(partial?.hudJudge ?? {}) },
  };
}
