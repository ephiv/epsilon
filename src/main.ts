import './styles.css';
import {
  buildReplayTimeline,
  getSnapshotAt,
  lowerBound,
  parseBeatmapBytes,
  parseReplayBuffer,
  type BeatmapFile,
  type FrameSnapshot,
  type HitsoundLayer,
  type RenderSettings,
  type ReplayData,
  type ReplayTimeline,
} from './core';
import { buildCustomNoteskinBitmaps, buildDefaultNoteskinBitmaps, collectBitmapTransferables, type NoteskinSet } from './render/noteskin';
import { renderFrame } from './render/renderer';
import { DEFAULT_RENDER_SETTINGS, mergeRenderSettings } from './render/settings';

type RenderDriver =
  | {
      kind: 'worker';
      worker: Worker;
      render: (time: number) => void;
      resize: (width: number, height: number) => void;
      scene: (timeline: ReplayTimeline | null, settings: RenderSettings) => void;
      font: (family: string | null, bytes: ArrayBuffer | null) => void;
      assets: (noteskin: NoteskinSet<ImageBitmap> | null, background: ImageBitmap | null) => void;
    }
  | {
      kind: 'main';
      ctx: CanvasRenderingContext2D;
      render: (time: number) => void;
      resize: (width: number, height: number) => void;
      scene: (timeline: ReplayTimeline | null, settings: RenderSettings) => void;
      font: (_family: string | null, _bytes: ArrayBuffer | null) => void;
      assets: (noteskin: NoteskinSet<ImageBitmap> | null, background: ImageBitmap | null) => void;
    };

type HudSettingKey = 'hudScore' | 'hudAcc' | 'hudCombo' | 'hudJudge';

interface AppState {
  beatmap: BeatmapFile | null;
  replay: ReplayData | null;
  timeline: ReplayTimeline | null;
  noteskin: NoteskinSet<ImageBitmap> | null;
  background: ImageBitmap | null;
  settings: RenderSettings;
  playing: boolean;
  currentTime: number;
  playbackAnchorTime: number;
  playbackAnchorWall: number;
  beatmapFiles: Map<string, File>;
  skinFiles: Map<string, File>;
  judgementFiles: File[];
  customFontFile: File | null;
  customFontBytes: ArrayBuffer | null;
  audioOverrideFile: File | null;
  backgroundOverrideFile: File | null;
  audioUrl: string | null;
  bgUrl: string | null;
}

interface FloatingPanelState {
  minimized: boolean;
  x: number;
  y: number;
}

function stripHitsoundIndex(filename: string): string {
  return filename.replace(/(\D)\d+(?=\.[^.]+$)/i, '$1');
}

function resolvePreviewHitsoundFile(layer: HitsoundLayer, beatmapFiles: Map<string, File>, skinFiles: Map<string, File>): File | null {
  const candidates =
    layer.kind === 'custom'
      ? [layer.filename]
      : [layer.filename, stripHitsoundIndex(layer.filename)];
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    const beatmapFile = beatmapFiles.get(normalized);
    if (beatmapFile) return beatmapFile;
    const skinFile = skinFiles.get(normalized);
    if (skinFile) return skinFile;
  }
  return null;
}

class PreviewHitsoundPlayer {
  private context: AudioContext | null = null;
  private cache = new Map<string, AudioBuffer>();
  private scheduled: AudioBufferSourceNode[] = [];
  private nextEventIndex = 0;

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
    }
    return this.context;
  }

  async resume(): Promise<void> {
    const context = this.ensureContext();
    if (context.state !== 'running') {
      await context.resume();
    }
  }

  stop(): void {
    for (const source of this.scheduled) {
      try {
        source.stop();
      } catch {
        // no-op
      }
    }
    this.scheduled = [];
  }

  seek(timeline: ReplayTimeline | null, time: number): void {
    this.stop();
    if (!timeline) {
      this.nextEventIndex = 0;
      return;
    }
    this.nextEventIndex = lowerBound(timeline.sampleEvents, time, (event) => event.time);
  }

  private async decodeFile(file: File): Promise<AudioBuffer> {
    const existing = this.cache.get(file.name);
    if (existing) return existing;
    const context = this.ensureContext();
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    this.cache.set(file.name, decoded);
    return decoded;
  }

  async schedule(timeline: ReplayTimeline | null, currentTimeMs: number, beatmapFiles: Map<string, File>, skinFiles: Map<string, File>): Promise<void> {
    if (!timeline) return;
    const context = this.ensureContext();
    const lookaheadMs = 120;
    while (this.nextEventIndex < timeline.sampleEvents.length) {
      const event = timeline.sampleEvents[this.nextEventIndex];
      if (event.time > currentTimeMs + lookaheadMs) break;
      for (const layer of event.layers) {
        const file = resolvePreviewHitsoundFile(layer, beatmapFiles, skinFiles);
        if (!file) continue;
        try {
          const buffer = await this.decodeFile(file);
          const source = context.createBufferSource();
          const gain = context.createGain();
          gain.gain.value = Math.max(0, Math.min(1, layer.volume / 100)) * 0.45;
          source.buffer = buffer;
          source.connect(gain);
          gain.connect(context.destination);
          source.start(context.currentTime + Math.max(0, (event.time - currentTimeMs) / 1000));
          source.onended = () => {
            this.scheduled = this.scheduled.filter((candidate) => candidate !== source);
          };
          this.scheduled.push(source);
        } catch {
          // Ignore undecodable sample files during preview playback.
        }
      }
      this.nextEventIndex += 1;
    }
  }
}

function formatMs(time: number): string {
  const safe = Math.max(0, Math.round(time));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const milliseconds = safe % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function formatDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Unknown';
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function revokeUrl(url: string | null): void {
  if (url) URL.revokeObjectURL(url);
}

function hudPosition(anchor: RenderSettings[HudSettingKey], width: number, height: number): { x: number; y: number } {
  const baseX = anchor.anchor.endsWith('l') ? 0 : anchor.anchor.endsWith('r') ? width : width / 2;
  const baseY = anchor.anchor.startsWith('t') ? 0 : anchor.anchor.startsWith('b') ? height : height / 2;
  return { x: baseX + anchor.offsetX, y: baseY + anchor.offsetY };
}

function formatMods(replay: ReplayData | null): string {
  if (!replay) return 'no replay';
  return replay.header.modNames.map((name) => name.toLowerCase()).join(', ') || 'no mod';
}

function validationSummary(timeline: ReplayTimeline | null): string {
  if (!timeline) return 'waiting for matching beatmap and replay.';
  if (!timeline.validation.messages.length) return 'replay header matched counts, combo, score, and accuracy.';
  return timeline.validation.messages.join(' | ');
}

function hudLabel(key: HudSettingKey): string {
  switch (key) {
    case 'hudScore':
      return 'score';
    case 'hudAcc':
      return 'accuracy';
    case 'hudCombo':
      return 'combo';
    default:
      return 'judgement';
  }
}

async function registerCustomFont(file: File): Promise<{ family: string; bytes: ArrayBuffer }> {
  const family = `hud-${file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${Date.now().toString(36)}`;
  const bytes = await file.arrayBuffer();
  const sourceUrl = URL.createObjectURL(file);
  try {
    const fontFace = new FontFace(family, `url(${sourceUrl})`);
    await fontFace.load();
    document.fonts.add(fontFace);
    return { family, bytes };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function mergeJudgementOverlay(
  base: NoteskinSet<ImageBitmap>,
  overlay: NoteskinSet<ImageBitmap>,
): NoteskinSet<ImageBitmap> {
  return {
    ...base,
    name: overlay.name || base.name,
    judgements: {
      ...base.judgements,
      ...overlay.judgements,
    },
  };
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Missing #app container.');
}

app.innerHTML = `
  <div class="site-shell">
    <nav class="site-nav">
      <a class="site-logo" href="https://ephiv.github.io/index.html" aria-label="home">
        <img src="https://ephiv.github.io/avatar.jpg" alt="site logo" />
      </a>
      <a href="https://ephiv.github.io/index.html">home</a>
      <a href="https://ephiv.github.io/projects.html" class="active">projects</a>
      <a href="https://ephiv.github.io/resources.html">resources</a>
      <a href="https://ephiv.github.io/blog">blog</a>
    </nav>

    <a href="https://ephiv.github.io/projects.html" class="back-link">projects</a>
    <div class="wordmark">replay renderer</div>
    <h1>epsilon</h1>
    <p class="header-desc">replay-accurate osu!mania preview with imported noteskins, etterna judgement assets, draggable hud placement, and a deterministic offline render core</p>

    <div class="app-grid">
      <aside class="sidebar">
        <section class="panel">
          <div class="ptitle">files</div>
          <label class="dz" id="dz-osu">
            <input type="file" accept=".osu" id="fi-osu" />
            <div>
              <div class="dz-lbl">beatmap file</div>
              <div class="dz-sub" id="n-osu">required .osu</div>
            </div>
          </label>
          <label class="dz" id="dz-assets">
            <input type="file" id="fi-assets" webkitdirectory multiple />
            <div>
              <div class="dz-lbl">beatmap assets folder</div>
              <div class="dz-sub" id="n-assets">audio, background, hitsounds</div>
            </div>
          </label>
          <label class="dz" id="dz-osr">
            <input type="file" accept=".osr" id="fi-osr" />
            <div>
              <div class="dz-lbl">replay file</div>
              <div class="dz-sub" id="n-osr">stable .osr</div>
            </div>
          </label>
          <label class="dz" id="dz-audio">
            <input type="file" accept=".mp3,.ogg,.wav" id="fi-audio" />
            <div>
              <div class="dz-lbl">audio override</div>
              <div class="dz-sub" id="n-audio">optional song file</div>
            </div>
          </label>
          <label class="dz" id="dz-bg">
            <input type="file" accept="image/*" id="fi-bg" />
            <div>
              <div class="dz-lbl">background override</div>
              <div class="dz-sub" id="n-bg">optional image</div>
            </div>
          </label>
        </section>

        <section class="panel">
          <div class="ptitle">noteskin</div>
          <div class="meta-row">
            <span class="tlbl">active skin</span>
            <span class="skin-badge"><span class="skin-dot"></span><span id="skin-name">ambiezerotwo</span></span>
          </div>
          <label class="dz compact" id="dz-skin">
            <input type="file" id="fi-skin" webkitdirectory multiple />
            <div>
              <div class="dz-lbl">import noteskin</div>
              <div class="dz-sub" id="n-skin">Etterna or osu!mania folder</div>
            </div>
          </label>
          <label class="dz compact" id="dz-judge">
            <input type="file" id="fi-judge" webkitdirectory multiple />
            <div>
              <div class="dz-lbl">judgement images</div>
              <div class="dz-sub" id="n-judge">1x6 strip or separate files</div>
            </div>
          </label>
          <div class="stack-actions">
            <button class="btn" id="reload-default-skin" type="button">restore default assets</button>
          </div>
        </section>

        <section class="panel">
          <div class="ptitle">playfield</div>
          <div class="srow">
            <span class="slbl">scroll speed</span>
            <input id="scroll-speed" type="range" min="10" max="40" step="0.5" />
            <span class="sval" id="scroll-speed-val"></span>
          </div>
          <div class="srow">
            <span class="slbl">hit position</span>
            <input id="hit-position" type="range" min="0.55" max="0.95" step="0.01" />
            <span class="sval" id="hit-position-val"></span>
          </div>
          <div class="srow">
            <span class="slbl">lane width</span>
            <input id="lane-width" type="range" min="46" max="108" step="1" />
            <span class="sval" id="lane-width-val"></span>
          </div>
          <div class="srow">
            <span class="slbl">lane gap</span>
            <input id="lane-gap" type="range" min="0" max="12" step="1" />
            <span class="sval" id="lane-gap-val"></span>
          </div>
          <div class="srow">
            <span class="slbl">border width</span>
            <input id="lane-border-width" type="range" min="0" max="4" step="0.5" />
            <span class="sval" id="lane-border-width-val"></span>
          </div>
          <div class="srow">
            <span class="slbl">dim background</span>
            <input id="dim-bg" type="range" min="0" max="1" step="0.01" />
            <span class="sval" id="dim-bg-val"></span>
          </div>
          <div class="srow">
            <span class="slbl">judge line</span>
            <input id="judge-line-opacity" type="range" min="0" max="1" step="0.01" />
            <span class="sval" id="judge-line-opacity-val"></span>
          </div>
          <div class="srow">
            <span class="slbl">playfield</span>
            <input id="playfield-opacity" type="range" min="0.35" max="1" step="0.01" />
            <span class="sval" id="playfield-opacity-val"></span>
          </div>
        </section>

        <section class="panel">
          <div class="ptitle">style</div>
          <div class="trow">
            <span class="tlbl">keypress glow</span>
            <button class="tog" id="show-keypress" type="button" aria-label="toggle keypress glow"></button>
          </div>
          <label class="text-field">
            <span class="tlbl">lane color</span>
            <input class="sinput" id="lane-color" type="text" />
          </label>
          <label class="text-field">
            <span class="tlbl">border color</span>
            <input class="sinput" id="lane-border-color" type="text" />
          </label>
          <label class="text-field">
            <span class="tlbl">custom font</span>
            <input class="sinput" id="custom-font" type="text" placeholder="nunito" />
          </label>
          <label class="dz compact" id="dz-font">
            <input type="file" id="fi-font" accept=".ttf,.otf,.woff,.woff2" />
            <div>
              <div class="dz-lbl">import hud font</div>
              <div class="dz-sub" id="n-font">score, combo, accuracy</div>
            </div>
          </label>
          <label class="text-field">
            <span class="tlbl">shutter samples</span>
            <input class="sinput" id="shutter-samples" type="number" min="1" max="12" step="1" />
          </label>
          <div class="btn-row">
            <button class="btn" id="reset-look" type="button">reset look</button>
            <button class="btn btn-primary" id="edit-hud" type="button">edit hud</button>
          </div>
        </section>

        <section class="panel">
          <div class="ptitle">export</div>
          <label class="text-field">
            <span class="tlbl">format</span>
            <select class="sinput" id="export-format">
              <option value="webm" selected>webm (browser)</option>
            </select>
          </label>
          <label class="text-field">
            <span class="tlbl">filename</span>
            <input class="sinput" id="export-name" type="text" value="epsilon-render" />
          </label>
          <div class="field-grid">
            <label class="text-field">
              <span class="tlbl">width</span>
              <input class="sinput" id="export-width" type="number" min="640" step="2" value="1920" />
            </label>
            <label class="text-field">
              <span class="tlbl">height</span>
              <input class="sinput" id="export-height" type="number" min="360" step="2" value="1080" />
            </label>
          </div>
          <div class="field-grid">
            <label class="text-field">
              <span class="tlbl">fps</span>
              <input class="sinput" id="export-fps" type="number" min="24" max="240" step="1" value="60" />
            </label>
            <label class="text-field">
              <span class="tlbl">shutter</span>
              <input class="sinput" id="export-shutter" type="number" min="1" max="12" step="1" value="1" />
            </label>
          </div>
          <div class="field-grid">
            <label class="text-field">
              <span class="tlbl">lead-in ms</span>
              <input class="sinput" id="export-lead-in" type="number" min="0" step="50" value="0" />
            </label>
            <label class="text-field">
              <span class="tlbl">tail pad ms</span>
              <input class="sinput" id="export-tail-pad" type="number" min="0" step="100" value="2000" />
            </label>
          </div>
          <div class="status-card export-card">
            <div class="status-line" id="export-status-line">load a beatmap and replay to export.</div>
            <div class="status-sub" id="export-progress-wrap" style="display:none">
              <progress id="export-progress" value="0" max="100" style="width:100%;margin-top:6px;accent-color:#a78bfa"></progress>
            </div>
          </div>
          <div class="btn-row">
            <button class="btn" id="download-settings" type="button">download settings</button>
            <button class="btn btn-primary" id="start-export" type="button" disabled>render video</button>
            <button class="btn" id="cancel-export" type="button" style="display:none">cancel</button>
          </div>
        </section>

        <section class="panel panel-last">
          <div class="ptitle">status</div>
          <div class="status-card">
            <div class="status-line" id="status-line">waiting for files.</div>
            <div class="status-sub" id="validation-line">load a beatmap and replay to validate the simulation.</div>
          </div>
        </section>
      </aside>

      <section class="main-stack">
        <div class="main-area">
          <div class="stage-head">
            <div>
              <div class="stage-kicker">replay session</div>
              <div class="stage-title" id="stage-title">no beatmap loaded</div>
              <div class="stage-subtitle" id="stage-subtitle">load a stable beatmap and replay to drive the preview analytically.</div>
            </div>
            <div class="stage-pills">
              <span class="pill" id="pill-keys">keys</span>
              <span class="pill" id="pill-mods">mods</span>
              <span class="pill" id="pill-rate">1.00x</span>
            </div>
          </div>

          <div class="canvas-wrap" id="canvas-wrap">
            <canvas id="preview" width="1280" height="720"></canvas>
            <audio id="song-audio" preload="auto"></audio>
            <div class="empty-state" id="empty-state">
              <div class="big">epsilon</div>
              <div class="msg">replay-driven preview will appear here.</div>
            </div>
            <div class="hud-editor" id="hud-editor">
              <div class="hud-anchor-grid">
                <div class="hud-cell"></div>
                <div class="hud-cell"></div>
                <div class="hud-cell"></div>
                <div class="hud-cell"></div>
                <div class="hud-cell"></div>
                <div class="hud-cell"></div>
                <div class="hud-cell"></div>
                <div class="hud-cell"></div>
                <div class="hud-cell"></div>
              </div>
              <div class="hud-draggable" data-hud="hudScore">score</div>
              <div class="hud-draggable" data-hud="hudAcc">accuracy</div>
              <div class="hud-draggable" data-hud="hudCombo">combo</div>
              <div class="hud-draggable" data-hud="hudJudge">judgement</div>
              <div class="hud-editor-panel" id="hud-editor-panel">
                <div class="hud-editor-head" id="hud-editor-head">
                  <span>hud editor</span>
                  <div class="hud-editor-head-actions">
                    <button class="btn" id="toggle-hud-panel" type="button">minimize</button>
                    <button class="btn btn-primary" id="close-hud" type="button">done</button>
                  </div>
                </div>
                <div class="hud-editor-body" id="hud-editor-body">
                  <span id="hud-editor-copy">drag hud labels to reposition the canvas overlay.</span>
                  <div class="hud-editor-controls">
                    <span class="hud-editor-label" id="hud-selected-label">score</span>
                    <input id="hud-size" class="hud-size-slider" type="range" min="0.5" max="2.5" step="0.05" value="1" />
                    <span class="hud-editor-value" id="hud-size-value">1.00x</span>
                    <button class="btn" id="reset-selected-hud" type="button">reset selected</button>
                  </div>
                  <div class="hud-editor-buttons">
                    <button class="btn" id="reset-hud" type="button">reset hud</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="ctrl-bar">
            <button class="cbtn" id="play-toggle" type="button">play</button>
            <button class="cbtn" id="reset-time" type="button">reset</button>
            <div class="scrub-wrap">
              <input id="scrubber" type="range" min="0" max="1" step="1" value="0" />
              <div class="time-row">
                <span id="time-current">00:00.000</span>
                <span id="time-total">00:00.001</span>
              </div>
            </div>
            <span class="bpm-chip" id="mode-chip">main thread</span>
          </div>
        </div>

        <div class="info-row-outer">
          <div class="iblock">
            <div class="ititl">beatmap</div>
            <div class="irow"><span class="ikey">title</span><span class="ival" id="info-title">not loaded</span></div>
            <div class="irow"><span class="ikey">difficulty</span><span class="ival" id="info-diff">-</span></div>
            <div class="irow"><span class="ikey">keys</span><span class="ival" id="info-keys">-</span></div>
            <div class="irow"><span class="ikey">audio</span><span class="ival" id="info-audio">-</span></div>
            <div class="irow"><span class="ikey">background</span><span class="ival" id="info-background">-</span></div>
          </div>
          <div class="iblock">
            <div class="ititl">replay</div>
            <div class="irow"><span class="ikey">player</span><span class="ival" id="info-player">not loaded</span></div>
            <div class="irow"><span class="ikey">mods</span><span class="ival" id="info-mods">-</span></div>
            <div class="irow"><span class="ikey">clock rate</span><span class="ival" id="info-rate">-</span></div>
            <div class="irow"><span class="ikey">scoring</span><span class="ival" id="info-scoring">-</span></div>
            <div class="irow"><span class="ikey">played</span><span class="ival" id="info-timestamp">-</span></div>
          </div>
          <div class="iblock">
            <div class="ititl">live results</div>
            <div class="irow"><span class="ikey">score</span><span class="ival mono" id="live-score">00000000</span></div>
            <div class="irow"><span class="ikey">accuracy</span><span class="ival mono" id="live-acc">100.00%</span></div>
            <div class="irow"><span class="ikey">combo</span><span class="ival mono" id="live-combo">0x</span></div>
            <div class="irow"><span class="ikey">validation</span><span class="ival validation-ok" id="live-validation">waiting</span></div>
            <div class="judgement-bars">
              <div class="jbar"><span class="jlbl j-w1">max</span><span class="jtrk"><span class="jfil j-w1" id="bar-320"></span></span><span class="jcnt" id="count-320">0</span></div>
              <div class="jbar"><span class="jlbl j-w2">300</span><span class="jtrk"><span class="jfil j-w2" id="bar-300"></span></span><span class="jcnt" id="count-300">0</span></div>
              <div class="jbar"><span class="jlbl j-w3">200</span><span class="jtrk"><span class="jfil j-w3" id="bar-200"></span></span><span class="jcnt" id="count-200">0</span></div>
              <div class="jbar"><span class="jlbl j-w4">100</span><span class="jtrk"><span class="jfil j-w4" id="bar-100"></span></span><span class="jcnt" id="count-100">0</span></div>
              <div class="jbar"><span class="jlbl j-w5">50</span><span class="jtrk"><span class="jfil j-w5" id="bar-50"></span></span><span class="jcnt" id="count-50">0</span></div>
              <div class="jbar"><span class="jlbl j-miss">miss</span><span class="jtrk"><span class="jfil j-miss" id="bar-miss"></span></span><span class="jcnt" id="count-miss">0</span></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
`;

const beatmapFolderInput = document.querySelector<HTMLInputElement>('#fi-assets')!;
const osuFileInput = document.querySelector<HTMLInputElement>('#fi-osu')!;
const osrFileInput = document.querySelector<HTMLInputElement>('#fi-osr')!;
const audioInput = document.querySelector<HTMLInputElement>('#fi-audio')!;
const backgroundInput = document.querySelector<HTMLInputElement>('#fi-bg')!;
const skinFolderInput = document.querySelector<HTMLInputElement>('#fi-skin')!;
const judgementFolderInput = document.querySelector<HTMLInputElement>('#fi-judge')!;
const fontInput = document.querySelector<HTMLInputElement>('#fi-font')!;
const playToggle = document.querySelector<HTMLButtonElement>('#play-toggle')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset-time')!;
const scrubber = document.querySelector<HTMLInputElement>('#scrubber')!;
const modeChip = document.querySelector<HTMLSpanElement>('#mode-chip')!;
const timeCurrent = document.querySelector<HTMLSpanElement>('#time-current')!;
const timeTotal = document.querySelector<HTMLSpanElement>('#time-total')!;
const statusLine = document.querySelector<HTMLDivElement>('#status-line')!;
const validationLine = document.querySelector<HTMLDivElement>('#validation-line')!;
const skinName = document.querySelector<HTMLSpanElement>('#skin-name')!;
const stageTitle = document.querySelector<HTMLDivElement>('#stage-title')!;
const stageSubtitle = document.querySelector<HTMLDivElement>('#stage-subtitle')!;
const pillKeys = document.querySelector<HTMLSpanElement>('#pill-keys')!;
const pillMods = document.querySelector<HTMLSpanElement>('#pill-mods')!;
const pillRate = document.querySelector<HTMLSpanElement>('#pill-rate')!;
const infoTitle = document.querySelector<HTMLSpanElement>('#info-title')!;
const infoDiff = document.querySelector<HTMLSpanElement>('#info-diff')!;
const infoKeys = document.querySelector<HTMLSpanElement>('#info-keys')!;
const infoAudio = document.querySelector<HTMLSpanElement>('#info-audio')!;
const infoBackground = document.querySelector<HTMLSpanElement>('#info-background')!;
const infoPlayer = document.querySelector<HTMLSpanElement>('#info-player')!;
const infoMods = document.querySelector<HTMLSpanElement>('#info-mods')!;
const infoRate = document.querySelector<HTMLSpanElement>('#info-rate')!;
const infoScoring = document.querySelector<HTMLSpanElement>('#info-scoring')!;
const infoTimestamp = document.querySelector<HTMLSpanElement>('#info-timestamp')!;
const liveScore = document.querySelector<HTMLSpanElement>('#live-score')!;
const liveAcc = document.querySelector<HTMLSpanElement>('#live-acc')!;
const liveCombo = document.querySelector<HTMLSpanElement>('#live-combo')!;
const liveValidation = document.querySelector<HTMLSpanElement>('#live-validation')!;
const reloadDefaultSkinButton = document.querySelector<HTMLButtonElement>('#reload-default-skin')!;
const editHudButton = document.querySelector<HTMLButtonElement>('#edit-hud')!;
const closeHudButton = document.querySelector<HTMLButtonElement>('#close-hud')!;
const toggleHudPanelButton = document.querySelector<HTMLButtonElement>('#toggle-hud-panel')!;
const resetHudButton = document.querySelector<HTMLButtonElement>('#reset-hud')!;
const resetSelectedHudButton = document.querySelector<HTMLButtonElement>('#reset-selected-hud')!;
const resetLookButton = document.querySelector<HTMLButtonElement>('#reset-look')!;
const downloadSettingsButton = document.querySelector<HTMLButtonElement>('#download-settings')!;
const startExportButton = document.querySelector<HTMLButtonElement>('#start-export')!;
const cancelExportButton = document.querySelector<HTMLButtonElement>('#cancel-export')!;
const exportStatusLine = document.querySelector<HTMLDivElement>('#export-status-line')!;
const exportProgressWrap = document.querySelector<HTMLDivElement>('#export-progress-wrap')!;
const exportProgressBar = document.querySelector<HTMLProgressElement>('#export-progress')!;
const exportFormatInput = document.querySelector<HTMLSelectElement>('#export-format')!;
const exportNameInput = document.querySelector<HTMLInputElement>('#export-name')!;
const exportWidthInput = document.querySelector<HTMLInputElement>('#export-width')!;
const exportHeightInput = document.querySelector<HTMLInputElement>('#export-height')!;
const exportFpsInput = document.querySelector<HTMLInputElement>('#export-fps')!;
const exportShutterInput = document.querySelector<HTMLInputElement>('#export-shutter')!;
const exportLeadInInput = document.querySelector<HTMLInputElement>('#export-lead-in')!;
const exportTailPadInput = document.querySelector<HTMLInputElement>('#export-tail-pad')!;
const emptyState = document.querySelector<HTMLDivElement>('#empty-state')!;
const hudEditor = document.querySelector<HTMLDivElement>('#hud-editor')!;
const hudEditorPanel = document.querySelector<HTMLDivElement>('#hud-editor-panel')!;
const hudEditorHead = document.querySelector<HTMLDivElement>('#hud-editor-head')!;
const hudEditorBody = document.querySelector<HTMLDivElement>('#hud-editor-body')!;
const hudSizeInput = document.querySelector<HTMLInputElement>('#hud-size')!;
const hudSizeValue = document.querySelector<HTMLSpanElement>('#hud-size-value')!;
const hudSelectedLabel = document.querySelector<HTMLSpanElement>('#hud-selected-label')!;
const canvasWrap = document.querySelector<HTMLDivElement>('#canvas-wrap')!;
const canvas = document.querySelector<HTMLCanvasElement>('#preview')!;
const audio = document.querySelector<HTMLAudioElement>('#song-audio')!;

const state: AppState = {
  beatmap: null,
  replay: null,
  timeline: null,
  noteskin: null,
  background: null,
  settings: mergeRenderSettings(DEFAULT_RENDER_SETTINGS),
  playing: false,
  currentTime: 0,
  playbackAnchorTime: 0,
  playbackAnchorWall: 0,
  beatmapFiles: new Map(),
  skinFiles: new Map(),
  judgementFiles: [],
  customFontFile: null,
  customFontBytes: null,
  audioOverrideFile: null,
  backgroundOverrideFile: null,
  audioUrl: null,
  bgUrl: null,
};

const hitsoundPlayer = new PreviewHitsoundPlayer();
let selectedHud: HudSettingKey = 'hudScore';
const hudPanelState: FloatingPanelState = {
  minimized: false,
  x: 18,
  y: 18,
};

function currentDuration(): number {
  return state.timeline ? Math.max(1, Math.ceil(state.timeline.beatmap.totalDuration)) : 1;
}

function currentSnapshot(): FrameSnapshot | null {
  return state.timeline ? getSnapshotAt(state.timeline, state.currentTime) : null;
}

function setLoadedDrop(dropId: string, labelId: string, label: string, loaded = false): void {
  const drop = document.querySelector<HTMLElement>(`#${dropId}`);
  const sub = document.querySelector<HTMLElement>(`#${labelId}`);
  if (!drop || !sub) return;
  sub.textContent = label;
  if (loaded) {
    drop.classList.add('loaded');
  } else {
    drop.classList.remove('loaded');
  }
}

function setStatus(primary: string, secondary: string): void {
  statusLine.textContent = primary;
  validationLine.textContent = secondary;
}

function updateStageMeta(): void {
  if (!state.beatmap) {
    stageTitle.textContent = 'no beatmap loaded';
    stageSubtitle.textContent = 'load a stable beatmap and replay to drive the preview analytically.';
    pillKeys.textContent = 'keys';
    pillMods.textContent = 'mods';
    pillRate.textContent = '1.00x';
    emptyState.classList.remove('hidden');
    return;
  }

  stageTitle.textContent = `${state.beatmap.artist} - ${state.beatmap.title}`;
  stageSubtitle.textContent = `${state.beatmap.version} • ${state.replay ? state.replay.header.playerName : 'waiting for replay'} • ${validationSummary(state.timeline)}`;
  pillKeys.textContent = `${state.beatmap.keyCount}K`;
  pillMods.textContent = formatMods(state.replay);
  pillRate.textContent = `${(state.timeline?.beatmap.clockRate ?? 1).toFixed(2)}x`;
  emptyState.classList.toggle('hidden', Boolean(state.timeline));
}

function updateInfoPanels(snapshot: FrameSnapshot | null): void {
  infoTitle.textContent = state.beatmap ? `${state.beatmap.artist} - ${state.beatmap.title}` : 'not loaded';
  infoDiff.textContent = state.beatmap ? `[${state.beatmap.version}]` : '-';
  infoKeys.textContent = state.beatmap ? `${state.beatmap.keyCount}K • OD ${state.beatmap.overallDifficulty.toFixed(1)}` : '-';
  infoAudio.textContent = state.audioOverrideFile?.name ?? state.beatmap?.audioFilename ?? '-';
  infoBackground.textContent = state.backgroundOverrideFile?.name ?? state.beatmap?.bgFilename ?? '-';

  infoPlayer.textContent = state.replay?.header.playerName ?? 'not loaded';
  infoMods.textContent = formatMods(state.replay);
  infoRate.textContent = state.timeline ? `${state.timeline.beatmap.clockRate.toFixed(2)}x` : '-';
  infoScoring.textContent = state.replay ? (state.replay.header.isScoreV2 ? 'scorev2' : 'scorev1') : '-';
  infoTimestamp.textContent = state.replay ? formatDate(state.replay.header.timestamp) : '-';

  const score = snapshot?.score ?? state.timeline?.finalScore ?? null;
  liveScore.textContent = score ? String(Math.round(score.score)).padStart(8, '0') : '00000000';
  liveAcc.textContent = score ? `${(score.accuracy * 100).toFixed(2)}%` : '100.00%';
  liveCombo.textContent = score ? `${score.combo}x` : '0x';

  const validationOk = !!state.timeline && state.timeline.validation.messages.length === 0;
  liveValidation.textContent = state.timeline ? (validationOk ? 'matched' : 'check header') : 'waiting';
  liveValidation.classList.toggle('validation-ok', validationOk);
  liveValidation.classList.toggle('validation-warn', Boolean(state.timeline && !validationOk));

  const counts = score?.counts ?? { '320': 0, '300': 0, '200': 0, '100': 0, '50': 0, miss: 0 };
  const total = Math.max(
    1,
    state.timeline?.beatmap.totalJudgementUnits ??
      counts['320'] + counts['300'] + counts['200'] + counts['100'] + counts['50'] + counts.miss,
  );
  const barValues: Array<[keyof typeof counts, string]> = [
    ['320', '320'],
    ['300', '300'],
    ['200', '200'],
    ['100', '100'],
    ['50', '50'],
    ['miss', 'miss'],
  ];
  for (const [key, suffix] of barValues) {
    const value = counts[key];
    const width = `${(value / total) * 100}%`;
    const bar = document.querySelector<HTMLElement>(`#bar-${suffix}`);
    const count = document.querySelector<HTMLElement>(`#count-${suffix}`);
    if (bar) bar.style.width = width;
    if (count) count.textContent = String(value);
  }
}

function updateSkinSummary(): void {
  skinName.textContent = (state.noteskin?.name ?? 'ambiezerotwo').toLowerCase();
}

function syncPlaybackButton(): void {
  playToggle.textContent = state.playing ? 'pause' : 'play';
  playToggle.classList.toggle('act', state.playing);
}

function syncUiToTime(): void {
  scrubber.max = String(currentDuration());
  scrubber.value = String(clamp(Math.round(state.currentTime), 0, currentDuration()));
  timeCurrent.textContent = formatMs(state.currentTime);
  timeTotal.textContent = formatMs(currentDuration());
  updateInfoPanels(currentSnapshot());
}

function currentCanvasSize(): { width: number; height: number } {
  return {
    width: canvas.clientWidth || canvas.width,
    height: canvas.clientHeight || canvas.height,
  };
}

function updateHudEditorUi(): void {
  hudSelectedLabel.textContent = hudLabel(selectedHud);
  hudSizeInput.value = String(state.settings[selectedHud].scale);
  hudSizeValue.textContent = `${state.settings[selectedHud].scale.toFixed(2)}x`;
  toggleHudPanelButton.textContent = hudPanelState.minimized ? 'expand' : 'minimize';
  hudEditorBody.classList.toggle('minimized', hudPanelState.minimized);
  for (const handle of Array.from(document.querySelectorAll<HTMLElement>('.hud-draggable'))) {
    const key = handle.dataset.hud as HudSettingKey | undefined;
    const active = key === selectedHud;
    handle.classList.toggle('active', active);
    if (key) {
      handle.style.fontSize = `${Math.max(11, Math.round(12 * state.settings[key].scale))}px`;
    }
  }
}

function clampHudPanelPosition(): void {
  const wrapWidth = canvasWrap.clientWidth || 1280;
  const wrapHeight = canvasWrap.clientHeight || 720;
  const panelWidth = hudEditorPanel.offsetWidth || 320;
  const panelHeight = hudEditorPanel.offsetHeight || 64;
  hudPanelState.x = clamp(hudPanelState.x, 8, Math.max(8, wrapWidth - panelWidth - 8));
  hudPanelState.y = clamp(hudPanelState.y, 8, Math.max(8, wrapHeight - panelHeight - 8));
}

function positionHudPanel(): void {
  clampHudPanelPosition();
  hudEditorPanel.style.left = `${hudPanelState.x}px`;
  hudEditorPanel.style.top = `${hudPanelState.y}px`;
}

function exportSettingsPayload(): RenderSettings {
  return mergeRenderSettings({
    ...state.settings,
    exportShutterSamples: clamp(Math.round(Number(exportShutterInput.value) || state.settings.exportShutterSamples || 1), 1, 12),
  });
}

function currentOutputExtension(): string {
  const format = exportFormatInput.value.trim().toLowerCase() || 'mp4';
  return ['mp4', 'mov', 'webm', 'mkv'].includes(format) ? format : 'mp4';
}

function exportOutputName(): string {
  const base = (exportNameInput.value.trim() || 'epsilon-render').replace(/\.(mp4|mov|webm|mkv)$/i, '');
  return `${base}.${currentOutputExtension()}`;
}

let activeExportWorker: Worker | null = null;

function refreshExportUi(): void {
  const ready = Boolean(state.timeline);
  startExportButton.disabled = !ready || activeExportWorker !== null;
  if (!ready) {
    exportStatusLine.textContent = 'load a beatmap and replay to export.';
  }
}

async function runBrowserExport(): Promise<void> {
  if (!state.timeline || !state.noteskin) return;

  const width = clamp(Math.round(Number(exportWidthInput.value) || 1920), 640, 7680);
  const height = clamp(Math.round(Number(exportHeightInput.value) || 1080), 360, 4320);
  const fps = clamp(Math.round(Number(exportFpsInput.value) || 60), 24, 240);
  const leadInMs = Math.max(0, Math.round(Number(exportLeadInInput.value) || 0));
  const tailPadMs = Math.max(0, Math.round(Number(exportTailPadInput.value) || 2000));
  const settings = exportSettingsPayload();

  // Use a hidden canvas + MediaRecorder for encoding
  const offscreen = new OffscreenCanvas(width, height);
  const ctx = offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D;
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable.');

  const frameDurationMs = 1000 / fps;
  const durationMs = leadInMs + state.timeline.beatmap.totalDuration + tailPadMs;
  const totalFrames = Math.ceil(durationMs / frameDurationMs);

  exportStatusLine.textContent = 'starting render…';
  exportProgressWrap.style.display = '';
  exportProgressBar.value = 0;
  exportProgressBar.max = totalFrames;
  startExportButton.disabled = true;
  cancelExportButton.style.display = '';

  let cancelled = false;
  cancelExportButton.onclick = () => { cancelled = true; };

  // Collect encoded frames as Blobs via ImageBitmap → canvas → blob
  const chunks: Blob[] = [];

  // We render inline (not in worker) to avoid ImageBitmap cloning complexity
  // This still runs "in the background" relative to the preview loop since
  // we yield via setTimeout between chunks of frames.
  const BATCH = 4; // frames per yield

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    if (cancelled) {
      exportStatusLine.textContent = 'export cancelled.';
      exportProgressWrap.style.display = 'none';
      cancelExportButton.style.display = 'none';
      refreshExportUi();
      return;
    }

    const frameTime = frameIndex * frameDurationMs - leadInMs;
    ctx.clearRect(0, 0, width, height);

    if (settings.exportShutterSamples > 1) {
      for (let s = 0; s < settings.exportShutterSamples; s++) {
        const sampleTime = frameTime + ((s + 0.5) / settings.exportShutterSamples - 0.5) * frameDurationMs;
        const snap = getSnapshotAt(state.timeline!, sampleTime);
        const temp = new OffscreenCanvas(width, height);
        const tc = temp.getContext('2d') as OffscreenCanvasRenderingContext2D;
        tc.clearRect(0, 0, width, height);
        renderFrame(tc as unknown as CanvasRenderingContext2D, state.timeline!, snap, settings, width, height, state.noteskin!, state.background);
        ctx.save();
        ctx.globalAlpha = 1 / settings.exportShutterSamples;
        ctx.drawImage(temp, 0, 0);
        ctx.restore();
      }
    } else {
      const snap = getSnapshotAt(state.timeline!, frameTime);
      renderFrame(ctx as unknown as CanvasRenderingContext2D, state.timeline!, snap, settings, width, height, state.noteskin!, state.background);
    }

    const blob = await offscreen.convertToBlob({ type: 'image/webp', quality: 0.92 });
    chunks.push(blob);

    exportProgressBar.value = frameIndex + 1;
    exportStatusLine.textContent = `rendering… ${frameIndex + 1}/${totalFrames}`;

    // Yield to browser every BATCH frames
    if (frameIndex % BATCH === BATCH - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  exportStatusLine.textContent = 'encoding video…';

  // Encode using WebM via MediaRecorder on a visible canvas
  const encoderCanvas = document.createElement('canvas');
  encoderCanvas.width = width;
  encoderCanvas.height = height;
  const encoderCtx = encoderCanvas.getContext('2d')!;
  const stream = encoderCanvas.captureStream(fps);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const recordedChunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };

  const recordingDone = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(recordedChunks, { type: mimeType }));
  });

  recorder.start();

  for (const frameBlob of chunks) {
    if (cancelled) break;
    const bitmap = await createImageBitmap(frameBlob);
    encoderCtx.clearRect(0, 0, width, height);
    encoderCtx.drawImage(bitmap, 0, 0);
    bitmap.close();
    // MediaRecorder samples the canvas stream automatically; just yield
    await new Promise<void>((resolve) => setTimeout(resolve, 1000 / fps));
  }

  recorder.stop();
  const videoBlob = await recordingDone;

  const url = URL.createObjectURL(videoBlob);
  const a = document.createElement('a');
  a.href = url;
  const base = (exportNameInput.value.trim() || 'epsilon-render').replace(/\.(webm|mp4|mkv|mov)$/i, '');
  a.download = `${base}.webm`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  exportStatusLine.textContent = `done! saved ${a.download}`;
  exportProgressWrap.style.display = 'none';
  cancelExportButton.style.display = 'none';
  refreshExportUi();
}

async function downloadSettingsFile(): Promise<void> {
  const blob = new Blob([JSON.stringify(exportSettingsPayload(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'epsilon-render-settings.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

function placeHudHandles(): void {
  const wrapRect = canvasWrap.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const width = canvasRect.width || currentCanvasSize().width;
  const height = canvasRect.height || currentCanvasSize().height;
  const offsetX = canvasRect.left - wrapRect.left;
  const offsetY = canvasRect.top - wrapRect.top;
  const handles = Array.from(document.querySelectorAll<HTMLElement>('.hud-draggable'));
  for (const handle of handles) {
    const key = handle.dataset.hud as HudSettingKey | undefined;
    if (!key) continue;
    const position = hudPosition(state.settings[key], width, height);
    handle.style.left = `${offsetX + position.x}px`;
    handle.style.top = `${offsetY + position.y}px`;
    handle.style.fontSize = `${Math.max(11, Math.round(12 * state.settings[key].scale))}px`;
  }
  updateHudEditorUi();
  positionHudPanel();
}

function applyScene(): void {
  driver.scene(state.timeline, state.settings);
  driver.font(state.settings.customFont, state.customFontBytes);
  driver.render(state.currentTime);
  updateStageMeta();
  syncUiToTime();
  placeHudHandles();
  refreshExportUi();
}

function pushAssets(): void {
  driver.assets(state.noteskin, state.background);
  driver.render(state.currentTime);
  updateSkinSummary();
}

function pausePlayback(): void {
  state.playing = false;
  syncPlaybackButton();
  audio.pause();
  hitsoundPlayer.stop();
}

function seek(time: number): void {
  state.currentTime = clamp(time, 0, currentDuration());
  if (audio.src) {
    audio.currentTime = state.currentTime / 1000;
  }
  hitsoundPlayer.seek(state.timeline, state.currentTime);
  syncUiToTime();
  driver.render(state.currentTime);
}

async function tick(): Promise<void> {
  if (!state.playing) return;
  if (audio.src && !audio.paused) {
    state.currentTime = audio.currentTime * 1000;
  } else {
    state.currentTime = state.playbackAnchorTime + (performance.now() - state.playbackAnchorWall);
  }
  if (state.currentTime >= currentDuration()) {
    pausePlayback();
    seek(currentDuration());
    return;
  }
  syncUiToTime();
  await hitsoundPlayer.schedule(state.timeline, state.currentTime, state.beatmapFiles, state.skinFiles);
  driver.render(state.currentTime);
  requestAnimationFrame(tick);
}

async function resolveBeatmapAssets(): Promise<void> {
  revokeUrl(state.audioUrl);
  revokeUrl(state.bgUrl);
  state.audioUrl = null;
  state.bgUrl = null;
  state.background = null;
  audio.pause();
  audio.removeAttribute('src');

  const backgroundFile = state.backgroundOverrideFile ?? (state.beatmap ? state.beatmapFiles.get(state.beatmap.bgFilename.toLowerCase()) ?? null : null);
  if (backgroundFile) {
    state.bgUrl = URL.createObjectURL(backgroundFile);
    state.background = await createImageBitmap(backgroundFile);
  }

  const audioFile = state.audioOverrideFile ?? (state.beatmap ? state.beatmapFiles.get(state.beatmap.audioFilename.toLowerCase()) ?? null : null);
  if (audioFile) {
    state.audioUrl = URL.createObjectURL(audioFile);
    audio.src = state.audioUrl;
    (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = false;
    audio.playbackRate = state.timeline?.beatmap.clockRate ?? 1;
  }

  pushAssets();
}

async function rebuildNoteskin(): Promise<void> {
  if (state.skinFiles.size > 0) {
    state.noteskin = await buildCustomNoteskinBitmaps(Array.from(state.skinFiles.values()), state.judgementFiles);
  } else if (state.judgementFiles.length > 0) {
    const base = await buildDefaultNoteskinBitmaps();
    const overlay = await buildCustomNoteskinBitmaps(state.judgementFiles);
    state.noteskin = mergeJudgementOverlay(base, overlay);
  } else {
    state.noteskin = await buildDefaultNoteskinBitmaps();
  }
  pushAssets();
}

async function rebuildTimeline(): Promise<void> {
  if (!state.beatmap || !state.replay) {
    state.timeline = null;
    applyScene();
    setStatus(
      state.beatmap ? 'beatmap loaded. waiting for replay.' : 'waiting for files.',
      validationSummary(state.timeline),
    );
    return;
  }

  state.timeline = buildReplayTimeline(state.beatmap, state.replay, { validateLifeGraph: true });
  audio.playbackRate = state.timeline.beatmap.clockRate;
  await resolveBeatmapAssets();
  setStatus(
    `ready: ${state.replay.header.playerName} on ${state.beatmap.artist} - ${state.beatmap.title}`,
    validationSummary(state.timeline),
  );
  applyScene();
}

function applyDefaultLook(): void {
  state.settings = mergeRenderSettings(DEFAULT_RENDER_SETTINGS);
  state.customFontFile = null;
  state.customFontBytes = null;
  fontInput.value = '';
  setLoadedDrop('dz-font', 'n-font', 'score, combo, accuracy', false);
  syncControlValuesFromSettings();
  applyScene();
}

async function safely(task: () => Promise<void> | void, fallbackPrimary: string): Promise<void> {
  try {
    await task();
  } catch (error) {
    pausePlayback();
    const message = error instanceof Error ? error.message : String(error);
    setStatus(fallbackPrimary, message);
  }
}

function createDriver(): RenderDriver {
  const offscreenCapableCanvas = canvas as HTMLCanvasElement & { transferControlToOffscreen?: () => OffscreenCanvas };
  if (typeof offscreenCapableCanvas.transferControlToOffscreen === 'function') {
    const worker = new Worker(new URL('./web/previewWorker.ts', import.meta.url), { type: 'module' });
    const offscreen = offscreenCapableCanvas.transferControlToOffscreen();
    worker.postMessage({ type: 'init', canvas: offscreen, width: canvas.width, height: canvas.height }, [offscreen]);
    modeChip.textContent = 'offscreen worker';
    let sentNoteskin: NoteskinSet<ImageBitmap> | null | undefined;
    let sentBackground: ImageBitmap | null | undefined;
    let sentFontFamily: string | null | undefined;
    let sentFontBytes: ArrayBuffer | null | undefined;
    return {
      kind: 'worker',
      worker,
      render: (time) => {
        worker.postMessage({ type: 'render', time });
      },
      resize: (width, height) => {
        worker.postMessage({ type: 'resize', width, height });
      },
      scene: (timeline, settings) => {
        worker.postMessage({ type: 'state', timeline, settings });
      },
      font: (family, bytes) => {
        if (family === sentFontFamily && bytes === sentFontBytes) return;
        worker.postMessage({ type: 'font', family, bytes });
        sentFontFamily = family;
        sentFontBytes = bytes;
      },
      assets: (noteskin, background) => {
        const payload: { type: 'assets'; noteskin?: NoteskinSet<ImageBitmap> | null; background?: ImageBitmap | null } = { type: 'assets' };
        const transferables: Transferable[] = [];
        if (noteskin !== sentNoteskin) {
          payload.noteskin = noteskin;
          transferables.push(...collectBitmapTransferables(noteskin, null));
          sentNoteskin = noteskin;
        }
        if (background !== sentBackground) {
          payload.background = background;
          if (background) transferables.push(background);
          sentBackground = background;
        }
        if ('noteskin' in payload || 'background' in payload) {
          worker.postMessage(payload, transferables);
        }
      },
    };
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('could not create 2d canvas context.');
  }
  modeChip.textContent = 'main thread';
  let sceneTimeline: ReplayTimeline | null = null;
  let sceneSettings = state.settings;
  let sceneNoteskin: NoteskinSet<ImageBitmap> | null = null;
  let sceneBackground: ImageBitmap | null = null;
  return {
    kind: 'main',
    ctx,
    render: (time) => {
      if (!sceneTimeline || !sceneNoteskin) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }
      const snapshot = getSnapshotAt(sceneTimeline, time);
      renderFrame(ctx, sceneTimeline, snapshot, sceneSettings, canvas.width, canvas.height, sceneNoteskin, sceneBackground);
    },
    resize: () => undefined,
    scene: (timeline, settings) => {
      sceneTimeline = timeline;
      sceneSettings = settings;
    },
    font: () => undefined,
    assets: (noteskin, background) => {
      sceneNoteskin = noteskin;
      sceneBackground = background;
    },
  };
}

const driver = createDriver();

const rangeBindings = [
  { id: 'scroll-speed', out: 'scroll-speed-val', get: () => state.settings.scrollSpeed, set: (value: number) => { state.settings.scrollSpeed = value; }, format: (value: number) => value.toFixed(1) },
  { id: 'hit-position', out: 'hit-position-val', get: () => state.settings.hitPosition, set: (value: number) => { state.settings.hitPosition = value; }, format: (value: number) => `${Math.round(value * 100)}%` },
  { id: 'lane-width', out: 'lane-width-val', get: () => state.settings.laneWidth, set: (value: number) => { state.settings.laneWidth = value; }, format: (value: number) => `${Math.round(value)}px` },
  { id: 'lane-gap', out: 'lane-gap-val', get: () => state.settings.laneGap, set: (value: number) => { state.settings.laneGap = value; }, format: (value: number) => `${Math.round(value)}px` },
  { id: 'lane-border-width', out: 'lane-border-width-val', get: () => state.settings.laneBorderWidth, set: (value: number) => { state.settings.laneBorderWidth = value; }, format: (value: number) => `${value.toFixed(1)}px` },
  { id: 'dim-bg', out: 'dim-bg-val', get: () => state.settings.dimBg, set: (value: number) => { state.settings.dimBg = value; }, format: (value: number) => `${Math.round(value * 100)}%` },
  { id: 'judge-line-opacity', out: 'judge-line-opacity-val', get: () => state.settings.judgeLineOpacity, set: (value: number) => { state.settings.judgeLineOpacity = value; }, format: (value: number) => `${Math.round(value * 100)}%` },
  { id: 'playfield-opacity', out: 'playfield-opacity-val', get: () => state.settings.playFieldOpacity, set: (value: number) => { state.settings.playFieldOpacity = value; }, format: (value: number) => `${Math.round(value * 100)}%` },
] as const;

function syncControlValuesFromSettings(): void {
  for (const binding of rangeBindings) {
    const input = document.querySelector<HTMLInputElement>(`#${binding.id}`);
    const output = document.querySelector<HTMLElement>(`#${binding.out}`);
    if (!input || !output) continue;
    const value = binding.get();
    input.value = String(value);
    output.textContent = binding.format(value);
  }

  const showKeypressButton = document.querySelector<HTMLButtonElement>('#show-keypress')!;
  showKeypressButton.classList.toggle('on', state.settings.showKeypress);
  const laneColorInput = document.querySelector<HTMLInputElement>('#lane-color')!;
  const laneBorderColorInput = document.querySelector<HTMLInputElement>('#lane-border-color')!;
  const customFontInput = document.querySelector<HTMLInputElement>('#custom-font')!;
  const shutterSamplesInput = document.querySelector<HTMLInputElement>('#shutter-samples')!;
  laneColorInput.value = state.settings.laneColor;
  laneBorderColorInput.value = state.settings.laneBorderColor;
  customFontInput.value = state.customFontFile ? state.customFontFile.name.replace(/\.[^.]+$/, '') : state.settings.customFont ?? '';
  shutterSamplesInput.value = String(state.settings.exportShutterSamples);
  exportShutterInput.value = String(state.settings.exportShutterSamples);
  updateHudEditorUi();
  refreshExportUi();
}

for (const binding of rangeBindings) {
  const input = document.querySelector<HTMLInputElement>(`#${binding.id}`);
  const output = document.querySelector<HTMLElement>(`#${binding.out}`);
  if (!input || !output) continue;
  input.addEventListener('input', () => {
    const value = Number(input.value);
    binding.set(value);
    output.textContent = binding.format(value);
    applyScene();
  });
}

const showKeypressButton = document.querySelector<HTMLButtonElement>('#show-keypress')!;
showKeypressButton.addEventListener('click', () => {
  state.settings.showKeypress = !state.settings.showKeypress;
  syncControlValuesFromSettings();
  applyScene();
});

const laneColorInput = document.querySelector<HTMLInputElement>('#lane-color')!;
laneColorInput.addEventListener('change', () => {
  state.settings.laneColor = laneColorInput.value.trim() || DEFAULT_RENDER_SETTINGS.laneColor;
  applyScene();
});

const laneBorderColorInput = document.querySelector<HTMLInputElement>('#lane-border-color')!;
laneBorderColorInput.addEventListener('change', () => {
  state.settings.laneBorderColor = laneBorderColorInput.value.trim() || DEFAULT_RENDER_SETTINGS.laneBorderColor;
  applyScene();
});

const customFontInput = document.querySelector<HTMLInputElement>('#custom-font')!;
customFontInput.addEventListener('change', () => {
  state.settings.customFont = customFontInput.value.trim() || null;
  state.customFontFile = null;
  state.customFontBytes = null;
  fontInput.value = '';
  setLoadedDrop('dz-font', 'n-font', 'score, combo, accuracy', false);
  applyScene();
});

const shutterSamplesInput = document.querySelector<HTMLInputElement>('#shutter-samples')!;
shutterSamplesInput.addEventListener('change', () => {
  state.settings.exportShutterSamples = clamp(Math.round(Number(shutterSamplesInput.value) || 1), 1, 12);
  syncControlValuesFromSettings();
  applyScene();
});

for (const input of [exportFormatInput, exportNameInput, exportWidthInput, exportHeightInput, exportFpsInput, exportShutterInput, exportLeadInInput, exportTailPadInput]) {
  input.addEventListener('input', () => {
    if (input === exportShutterInput) {
      state.settings.exportShutterSamples = clamp(Math.round(Number(exportShutterInput.value) || 1), 1, 12);
      shutterSamplesInput.value = String(state.settings.exportShutterSamples);
    }
    refreshExportUi();
  });
  input.addEventListener('change', () => {
    if (input === exportShutterInput) {
      state.settings.exportShutterSamples = clamp(Math.round(Number(exportShutterInput.value) || 1), 1, 12);
      shutterSamplesInput.value = String(state.settings.exportShutterSamples);
    }
    refreshExportUi();
  });
}

downloadSettingsButton.addEventListener('click', async () => {
  await safely(async () => {
    await downloadSettingsFile();
    setStatus('downloaded export settings.', validationSummary(state.timeline));
  }, 'could not download export settings.');
});

startExportButton.addEventListener('click', async () => {
  await safely(async () => {
    await runBrowserExport();
  }, 'export failed.');
});

fontInput.addEventListener('change', async () => {
  await safely(async () => {
    const file = fontInput.files?.[0] ?? null;
    state.customFontFile = file;
    if (!file) {
      state.settings.customFont = null;
      state.customFontBytes = null;
      setLoadedDrop('dz-font', 'n-font', 'score, combo, accuracy', false);
      syncControlValuesFromSettings();
      applyScene();
      return;
    }
    const registered = await registerCustomFont(file);
    state.settings.customFont = registered.family;
    state.customFontBytes = registered.bytes;
    setLoadedDrop('dz-font', 'n-font', file.name, true);
    syncControlValuesFromSettings();
    applyScene();
  }, 'could not load custom hud font.');
});

beatmapFolderInput.addEventListener('change', async () => {
  await safely(async () => {
    state.beatmapFiles.clear();
    for (const file of Array.from(beatmapFolderInput.files ?? [])) {
      state.beatmapFiles.set(file.name.toLowerCase(), file);
    }
    setLoadedDrop('dz-assets', 'n-assets', beatmapFolderInput.files?.length ? `${beatmapFolderInput.files.length} asset files` : 'audio, background, hitsounds', Boolean(beatmapFolderInput.files?.length));
    await resolveBeatmapAssets();
    syncUiToTime();
  }, 'could not load beatmap assets.');
});

osuFileInput.addEventListener('change', async () => {
  await safely(async () => {
    const file = osuFileInput.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    state.beatmap = parseBeatmapBytes(bytes);
    setLoadedDrop('dz-osu', 'n-osu', file.name, true);
    await rebuildTimeline();
  }, 'could not parse beatmap.');
});

osrFileInput.addEventListener('change', async () => {
  await safely(async () => {
    const file = osrFileInput.files?.[0];
    if (!file) return;
    if (!state.beatmap) {
      throw new Error('load the matching .osu file before the replay.');
    }
    state.replay = await parseReplayBuffer(await file.arrayBuffer(), state.beatmap.keyCount);
    setLoadedDrop('dz-osr', 'n-osr', file.name, true);
    await rebuildTimeline();
  }, 'could not parse replay.');
});

audioInput.addEventListener('change', async () => {
  await safely(async () => {
    state.audioOverrideFile = audioInput.files?.[0] ?? null;
    setLoadedDrop('dz-audio', 'n-audio', state.audioOverrideFile?.name ?? 'optional song file', Boolean(state.audioOverrideFile));
    await resolveBeatmapAssets();
    syncUiToTime();
  }, 'could not load audio override.');
});

backgroundInput.addEventListener('change', async () => {
  await safely(async () => {
    state.backgroundOverrideFile = backgroundInput.files?.[0] ?? null;
    setLoadedDrop('dz-bg', 'n-bg', state.backgroundOverrideFile?.name ?? 'optional image', Boolean(state.backgroundOverrideFile));
    await resolveBeatmapAssets();
    syncUiToTime();
  }, 'could not load background override.');
});

skinFolderInput.addEventListener('change', async () => {
  await safely(async () => {
    pausePlayback();
    state.skinFiles.clear();
    for (const file of Array.from(skinFolderInput.files ?? [])) {
      state.skinFiles.set(file.name.toLowerCase(), file);
    }
    setLoadedDrop('dz-skin', 'n-skin', state.skinFiles.size ? `${state.skinFiles.size} skin assets` : 'Etterna or osu!mania folder', state.skinFiles.size > 0);
    await rebuildNoteskin();
  }, 'could not load noteskin.');
});

judgementFolderInput.addEventListener('change', async () => {
  await safely(async () => {
    pausePlayback();
    state.judgementFiles = Array.from(judgementFolderInput.files ?? []);
    setLoadedDrop('dz-judge', 'n-judge', state.judgementFiles.length ? `${state.judgementFiles.length} judgement assets` : '1x6 strip or separate files', state.judgementFiles.length > 0);
    await rebuildNoteskin();
  }, 'could not load judgement assets.');
});

reloadDefaultSkinButton.addEventListener('click', async () => {
  await safely(async () => {
    pausePlayback();
    state.skinFiles.clear();
    state.judgementFiles = [];
    skinFolderInput.value = '';
    judgementFolderInput.value = '';
    setLoadedDrop('dz-skin', 'n-skin', 'Etterna or osu!mania folder', false);
    setLoadedDrop('dz-judge', 'n-judge', '1x6 strip or separate files', false);
    await rebuildNoteskin();
  }, 'could not restore default noteskin.');
});

playToggle.addEventListener('click', async () => {
  await safely(async () => {
    if (!state.timeline) return;
    if (state.playing) {
      pausePlayback();
      return;
    }
    state.playing = true;
    syncPlaybackButton();
    state.playbackAnchorTime = state.currentTime;
    state.playbackAnchorWall = performance.now();
    hitsoundPlayer.seek(state.timeline, state.currentTime);
    await hitsoundPlayer.resume().catch(() => undefined);
    if (audio.src) {
      audio.currentTime = state.currentTime / 1000;
      audio.playbackRate = state.timeline.beatmap.clockRate;
      (audio as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = false;
      await audio.play().catch(() => undefined);
    }
    requestAnimationFrame(tick);
  }, 'could not start playback.');
});

resetButton.addEventListener('click', () => {
  pausePlayback();
  seek(0);
});

scrubber.addEventListener('input', () => {
  pausePlayback();
  seek(Number(scrubber.value));
});

resetLookButton.addEventListener('click', () => {
  applyDefaultLook();
});

hudSizeInput.addEventListener('input', () => {
  state.settings[selectedHud].scale = clamp(Number(hudSizeInput.value), 0.5, 2.5);
  applyScene();
});

function setHudEditorOpen(open: boolean): void {
  hudEditor.classList.toggle('active', open);
  if (open) {
    positionHudPanel();
  }
  placeHudHandles();
  updateHudEditorUi();
}

editHudButton.addEventListener('click', () => {
  setHudEditorOpen(true);
});

closeHudButton.addEventListener('click', () => {
  setHudEditorOpen(false);
});

toggleHudPanelButton.addEventListener('click', () => {
  hudPanelState.minimized = !hudPanelState.minimized;
  updateHudEditorUi();
  positionHudPanel();
});

resetHudButton.addEventListener('click', () => {
  state.settings = mergeRenderSettings({
    ...state.settings,
    hudScore: DEFAULT_RENDER_SETTINGS.hudScore,
    hudAcc: DEFAULT_RENDER_SETTINGS.hudAcc,
    hudCombo: DEFAULT_RENDER_SETTINGS.hudCombo,
    hudJudge: DEFAULT_RENDER_SETTINGS.hudJudge,
  });
  applyScene();
});

resetSelectedHudButton.addEventListener('click', () => {
  state.settings[selectedHud] = { ...DEFAULT_RENDER_SETTINGS[selectedHud] };
  applyScene();
});

let dragState:
  | {
      key: HudSettingKey;
      pointerId: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
    }
  | null = null;

let hudPanelDragState:
  | {
      pointerId: number;
      startX: number;
      startY: number;
      originX: number;
      originY: number;
    }
  | null = null;

for (const handle of Array.from(document.querySelectorAll<HTMLElement>('.hud-draggable'))) {
  handle.addEventListener('pointerdown', (event) => {
    const key = handle.dataset.hud as HudSettingKey | undefined;
    if (!key) return;
    selectedHud = key;
    dragState = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: state.settings[key].offsetX,
      originY: state.settings[key].offsetY,
    };
    handle.setPointerCapture(event.pointerId);
    updateHudEditorUi();
    event.preventDefault();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    state.settings[dragState.key].offsetX = Math.round(dragState.originX + (event.clientX - dragState.startX));
    state.settings[dragState.key].offsetY = Math.round(dragState.originY + (event.clientY - dragState.startY));
    applyScene();
  });
  handle.addEventListener('wheel', (event) => {
    const key = handle.dataset.hud as HudSettingKey | undefined;
    if (!key) return;
    selectedHud = key;
    const delta = event.deltaY < 0 ? 0.05 : -0.05;
    state.settings[key].scale = clamp(Number((state.settings[key].scale + delta).toFixed(2)), 0.5, 2.5);
    updateHudEditorUi();
    applyScene();
    event.preventDefault();
  });
  handle.addEventListener('pointerup', () => {
    dragState = null;
  });
  handle.addEventListener('pointercancel', () => {
    dragState = null;
  });
}

hudEditorHead.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('button')) return;
  hudPanelDragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: hudPanelState.x,
    originY: hudPanelState.y,
  };
  hudEditorHead.setPointerCapture(event.pointerId);
  event.preventDefault();
});

hudEditorHead.addEventListener('pointermove', (event) => {
  if (!hudPanelDragState || hudPanelDragState.pointerId !== event.pointerId) return;
  hudPanelState.x = Math.round(hudPanelDragState.originX + (event.clientX - hudPanelDragState.startX));
  hudPanelState.y = Math.round(hudPanelDragState.originY + (event.clientY - hudPanelDragState.startY));
  positionHudPanel();
});

for (const eventName of ['pointerup', 'pointercancel'] as const) {
  hudEditorHead.addEventListener(eventName, () => {
    hudPanelDragState = null;
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && hudEditor.classList.contains('active')) {
    setHudEditorOpen(false);
  }
});

window.addEventListener('resize', () => {
  const stageWidth = canvasWrap.clientWidth || 1280;
  const stageHeight = canvasWrap.clientHeight || 720;
  const ratio = 16 / 9;
  let width = Math.max(640, stageWidth);
  let height = Math.round(width / ratio);
  if (height > stageHeight && stageHeight > 0) {
    height = stageHeight;
    width = Math.round(height * ratio);
  }
  canvas.width = width;
  canvas.height = height;
  driver.resize(width, height);
  driver.render(state.currentTime);
  placeHudHandles();
});

syncControlValuesFromSettings();
syncPlaybackButton();
updateSkinSummary();
updateStageMeta();
updateInfoPanels(null);
setStatus('waiting for files.', 'load a beatmap and replay to validate the simulation.');
await rebuildNoteskin();
window.dispatchEvent(new Event('resize'));
