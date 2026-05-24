import { getScrollPosition, lowerBound } from '../core';
import type { FrameSnapshot, ManiaGrade, PreparedBeatmap, RenderHudAnchor, RenderSettings, ReplayTimeline } from '../core';
import type { NoteskinSet, ColumnDirection } from './types';

type DrawingContext = CanvasRenderingContext2D & {
  roundRect?: (x: number, y: number, width: number, height: number, radii?: number | number[]) => void;
};

interface FrameMetrics {
  height: number;
  hitY: number;
  scrollRate: number;
  currentScroll: number;
}

interface RenderObjectCache {
  tapObjects: PreparedBeatmap['hitObjects'];
  holdObjectsByStart: PreparedBeatmap['hitObjects'];
  holdObjectsByEnd: PreparedBeatmap['hitObjects'];
}

const renderObjectCache = new WeakMap<PreparedBeatmap, RenderObjectCache>();

function imageWidth(image: unknown): number {
  if (!image || typeof image !== 'object') return 0;
  const candidate = image as { width?: number; naturalWidth?: number };
  return candidate.naturalWidth ?? candidate.width ?? 0;
}

function imageHeight(image: unknown): number {
  if (!image || typeof image !== 'object') return 0;
  const candidate = image as { height?: number; naturalHeight?: number };
  return candidate.naturalHeight ?? candidate.height ?? 0;
}

function hudPosition(anchor: RenderHudAnchor, width: number, height: number): { x: number; y: number } {
  const baseX = anchor.anchor.endsWith('l') ? 0 : anchor.anchor.endsWith('r') ? width : width / 2;
  const baseY = anchor.anchor.startsWith('t') ? 0 : anchor.anchor.startsWith('b') ? height : height / 2;
  return { x: baseX + anchor.offsetX, y: baseY + anchor.offsetY };
}

function getRenderCache(beatmap: PreparedBeatmap): RenderObjectCache {
  let cached = renderObjectCache.get(beatmap);
  if (cached) return cached;
  const tapObjects = beatmap.hitObjects.filter((object) => !object.isHold);
  const holdObjectsByStart = beatmap.hitObjects.filter((object) => object.isHold);
  const holdObjectsByEnd = [...holdObjectsByStart].sort((left, right) => left.endTime - right.endTime);
  cached = { tapObjects, holdObjectsByStart, holdObjectsByEnd };
  renderObjectCache.set(beatmap, cached);
  return cached;
}

function columnDirection(col: number, keyCount: number): ColumnDirection {
  const map4: ColumnDirection[] = ['Left', 'Down', 'Up', 'Right'];
  const map7: ColumnDirection[] = ['Left', 'Down', 'Left', 'Up', 'Right', 'Up', 'Right'];
  if (keyCount <= 4) return map4[col % 4];
  if (keyCount <= 7) return map7[col % 7];
  return map4[col % 4];
}

function noteColor(direction: ColumnDirection): string {
  const colors: Record<ColumnDirection, string> = {
    Left: '#4fc3f7',
    Down: '#81c784',
    Up: '#ff7043',
    Right: '#ce93d8',
  };
  return colors[direction];
}

function pxPerScrollUnit(height: number, settings: RenderSettings): number {
  const visibleMs = 13720 / settings.scrollSpeed;
  return (height * settings.hitPosition) / visibleMs;
}

function createFrameMetrics(beatmap: PreparedBeatmap, time: number, height: number, settings: RenderSettings): FrameMetrics {
  return {
    height,
    hitY: height * settings.hitPosition,
    scrollRate: pxPerScrollUnit(height, settings),
    currentScroll: getScrollPosition(beatmap, time),
  };
}

function noteY(beatmap: PreparedBeatmap, noteTime: number, frame: FrameMetrics): number {
  const noteScroll = getScrollPosition(beatmap, noteTime);
  return frame.hitY - (noteScroll - frame.currentScroll) * frame.scrollRate;
}

function drawRoundedRect(ctx: DrawingContext, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    ctx.rect(x, y, width, height);
  }
}

function drawBackground(ctx: DrawingContext, width: number, height: number, settings: RenderSettings, background: unknown): void {
  if (background && imageWidth(background) > 0 && imageHeight(background) > 0) {
    const bg = background as CanvasImageSource;
    const scale = Math.max(width / imageWidth(background), height / imageHeight(background));
    const drawWidth = imageWidth(background) * scale;
    const drawHeight = imageHeight(background) * scale;
    ctx.drawImage(bg, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  } else {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#08111c');
    gradient.addColorStop(1, '#140b1f');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.fillStyle = `rgba(0,0,0,${settings.dimBg})`;
  ctx.fillRect(0, 0, width, height);
}

function columnX(beatmap: PreparedBeatmap, settings: RenderSettings, width: number, col: number): number {
  const totalWidth = beatmap.keyCount * settings.laneWidth + (beatmap.keyCount - 1) * settings.laneGap;
  const startX = (width - totalWidth) / 2;
  return startX + col * (settings.laneWidth + settings.laneGap);
}

function drawPlayfield(
  ctx: DrawingContext,
  beatmap: PreparedBeatmap,
  snapshot: FrameSnapshot,
  width: number,
  height: number,
  settings: RenderSettings,
): void {
  const totalWidth = beatmap.keyCount * settings.laneWidth + (beatmap.keyCount - 1) * settings.laneGap;
  const startX = (width - totalWidth) / 2;
  const hitY = height * settings.hitPosition;

  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(startX - 2, 0, 2, height);
  ctx.fillRect(startX + totalWidth, 0, 2, height);

  for (let col = 0; col < beatmap.keyCount; col += 1) {
    const x = columnX(beatmap, settings, width, col);
    ctx.fillStyle = settings.laneColor;
    ctx.fillRect(x, 0, settings.laneWidth, height);
    if (settings.laneBorderWidth > 0) {
      ctx.fillStyle = settings.laneBorderColor;
      ctx.fillRect(x - settings.laneBorderWidth, 0, settings.laneBorderWidth, height);
    }
    if (settings.showKeypress && snapshot.keyStates[col]) {
      const gradient = ctx.createLinearGradient(x, 0, x, hitY);
      gradient.addColorStop(0, 'rgba(255,255,255,0)');
      gradient.addColorStop(1, 'rgba(255,255,255,0.1)');
      ctx.fillStyle = gradient;
      ctx.fillRect(x, 0, settings.laneWidth, hitY);
    }
  }

  ctx.save();
  ctx.globalAlpha = settings.judgeLineOpacity;
  ctx.shadowColor = '#fff';
  ctx.shadowBlur = 8;
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillRect(startX, hitY, totalWidth, 2);
  ctx.restore();
}

function drawTapNote(
  ctx: DrawingContext,
  x: number,
  y: number,
  width: number,
  direction: ColumnDirection,
  settings: RenderSettings,
  noteskin: NoteskinSet<unknown>,
): void {
  const image = noteskin.tapNotes[direction];
  if (image && imageWidth(image) > 0 && imageHeight(image) > 0) {
    ctx.drawImage(image as CanvasImageSource, x, y - width / 2, width, width);
    return;
  }

  const fill = noteColor(direction);
  ctx.fillStyle = fill;
  drawRoundedRect(ctx, x + 2, y - width / 2 + 2, width - 4, width - 4, 6);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.fillRect(x + 4, y - width / 2 + 4, width - 8, 3);
}

function drawHoldNote(
  ctx: DrawingContext,
  beatmap: PreparedBeatmap,
  snapshot: FrameSnapshot,
  width: number,
  settings: RenderSettings,
  noteskin: NoteskinSet<unknown>,
  object: PreparedBeatmap['hitObjects'][number],
  frame: FrameMetrics,
): void {
  const hold = snapshot.holdStates[object.id];
  if (!hold || !hold.visible) return;

  const direction = columnDirection(object.col, beatmap.keyCount);
  const x = columnX(beatmap, settings, width, object.col);
  const noteWidth = settings.laneWidth;
  const activeAnchorTime = hold.anchorTime;
  const headY = noteY(beatmap, activeAnchorTime, frame);
  const tailY = noteY(beatmap, object.endTime, frame);

  if (headY < -noteWidth && tailY < -noteWidth) return;
  if (headY > frame.height + noteWidth && tailY > frame.height + noteWidth) return;

  const bodyTop = Math.min(headY, tailY);
  const bodyBottom = Math.max(headY, tailY);
  const bodyHeight = Math.max(0, bodyBottom - bodyTop);
  const bodyX = x + noteWidth * 0.15;
  const bodyWidth = noteWidth * 0.7;
  const color = noteColor(direction);

  if (bodyHeight > 0) {
    if (noteskin.holdBody && imageWidth(noteskin.holdBody) > 0) {
      const image = noteskin.holdBody as CanvasImageSource;
      const sourceWidth = imageWidth(noteskin.holdBody);
      const sourceHeight = imageHeight(noteskin.holdBody);
      const scaledHeight = (sourceHeight / sourceWidth) * bodyWidth;
      ctx.save();
      ctx.beginPath();
      ctx.rect(bodyX, bodyTop, bodyWidth, bodyHeight);
      ctx.clip();
      for (let currentY = bodyTop; currentY < bodyBottom; currentY += scaledHeight) {
        ctx.drawImage(image, bodyX, currentY, bodyWidth, scaledHeight);
      }
      ctx.restore();
    } else {
      const gradient = ctx.createLinearGradient(bodyX, bodyTop, bodyX, bodyBottom);
      gradient.addColorStop(0, `${color}e0`);
      gradient.addColorStop(1, `${color}55`);
      ctx.fillStyle = gradient;
      drawRoundedRect(ctx, bodyX, bodyTop, bodyWidth, bodyHeight, 4);
      ctx.fill();
    }
  }

  const tailAsset = noteskin.holdTail ?? noteskin.holdCap;
  if (tailAsset && imageWidth(tailAsset) > 0) {
    const tailHeight = Math.max(12, Math.round((imageHeight(tailAsset) / Math.max(1, imageWidth(tailAsset))) * bodyWidth));
    ctx.drawImage(tailAsset as CanvasImageSource, bodyX, tailY - tailHeight / 2, bodyWidth, tailHeight);
  } else {
    ctx.fillStyle = color;
    ctx.fillRect(bodyX, tailY - 3, bodyWidth, 6);
  }

  if (!hold.holding) {
    drawTapNote(ctx, x, headY, noteWidth, direction, settings, noteskin);
  } else {
    drawTapNote(ctx, x, frame.hitY, noteWidth, direction, settings, noteskin);
  }
}

function drawNotes(
  ctx: DrawingContext,
  timeline: ReplayTimeline,
  snapshot: FrameSnapshot,
  width: number,
  height: number,
  settings: RenderSettings,
  noteskin: NoteskinSet<unknown>,
): void {
  const beatmap = timeline.beatmap;
  const frame = createFrameMetrics(beatmap, snapshot.time, height, settings);
  const cache = getRenderCache(beatmap);
  const lookAhead = frame.hitY / frame.scrollRate + 220;
  const lookBehind = ((height * (1 - settings.hitPosition)) / frame.scrollRate) + 220;
  const visibleStart = snapshot.time - lookBehind;
  const visibleEnd = snapshot.time + lookAhead;

  const holdStart = lowerBound(cache.holdObjectsByEnd, visibleStart, (object) => object.endTime);
  for (let index = holdStart; index < cache.holdObjectsByEnd.length; index += 1) {
    const object = cache.holdObjectsByEnd[index];
    if (object.startTime > visibleEnd) continue;
    drawHoldNote(ctx, beatmap, snapshot, width, settings, noteskin, object, frame);
  }

  const tapStart = lowerBound(cache.tapObjects, visibleStart, (object) => object.startTime);
  for (let index = tapStart; index < cache.tapObjects.length; index += 1) {
    const object = cache.tapObjects[index];
    if (object.startTime > visibleEnd) break;
    const tapState = snapshot.tapStates[object.id];
    if (!tapState?.visible) continue;
    const direction = columnDirection(object.col, beatmap.keyCount);
    const x = columnX(beatmap, settings, width, object.col);
    const y = noteY(beatmap, object.startTime, frame);
    drawTapNote(ctx, x, y, settings.laneWidth, direction, settings, noteskin);
  }
}

function drawReceptors(
  ctx: DrawingContext,
  beatmap: PreparedBeatmap,
  snapshot: FrameSnapshot,
  width: number,
  height: number,
  settings: RenderSettings,
  noteskin: NoteskinSet<unknown>,
): void {
  const hitY = height * settings.hitPosition;
  for (let col = 0; col < beatmap.keyCount; col += 1) {
    const x = columnX(beatmap, settings, width, col);
    const direction = columnDirection(col, beatmap.keyCount);
    const image = snapshot.keyStates[col] ? noteskin.receptorsPress[direction] : noteskin.receptorsGo[direction];
    if (image && imageWidth(image) > 0) {
      ctx.drawImage(image as CanvasImageSource, x, hitY - settings.laneWidth / 2, settings.laneWidth, settings.laneWidth);
      continue;
    }
    const color = noteColor(direction);
    ctx.strokeStyle = color;
    ctx.lineWidth = snapshot.keyStates[col] ? 2.5 : 1.5;
    ctx.globalAlpha = snapshot.keyStates[col] ? 1 : 0.45;
    drawRoundedRect(ctx, x + 3, hitY - settings.laneWidth / 2 + 3, settings.laneWidth - 6, settings.laneWidth - 6, 8);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function gradeToJudgementKey(grade: ManiaGrade): keyof NoteskinSet<unknown>['judgements'] {
  switch (grade) {
    case 320:
      return 'w1';
    case 300:
      return 'w2';
    case 200:
      return 'w3';
    case 100:
      return 'w4';
    case 50:
      return 'w5';
    default:
      return 'miss';
  }
}

function gradeLabel(grade: ManiaGrade): string {
  switch (grade) {
    case 320:
      return 'PERFECT';
    case 300:
      return 'GREAT';
    case 200:
      return 'GOOD';
    case 100:
      return 'OK';
    case 50:
      return 'MEH';
    default:
      return 'MISS';
  }
}

function gradeColor(grade: ManiaGrade): string {
  switch (grade) {
    case 320:
      return '#b0e0ff';
    case 300:
      return '#78f0a0';
    case 200:
      return '#fff07c';
    case 100:
      return '#f0a860';
    case 50:
      return '#f06060';
    default:
      return '#7d8594';
  }
}

function drawJudgeFlash(
  ctx: DrawingContext,
  snapshot: FrameSnapshot,
  width: number,
  height: number,
  settings: RenderSettings,
  noteskin: NoteskinSet<unknown>,
): void {
  if (!snapshot.latestJudgement) return;
  const age = (snapshot.time - snapshot.latestJudgement.time) / 700;
  if (age > 1) return;

  const alpha = Math.max(0, 1 - age * 1.6);
  const scale = settings.hudJudge.scale * (1 + age * 0.25);
  const position = hudPosition(settings.hudJudge, width, height);
  const image = noteskin.judgements[gradeToJudgementKey(snapshot.latestJudgement.grade)];
  if (image && imageWidth(image) > 0) {
    const baseScale = Math.min((width * 0.34) / imageWidth(image), (height * 0.12) / imageHeight(image), 1.25);
    const drawWidth = imageWidth(image) * baseScale * scale;
    const drawHeight = imageHeight(image) * baseScale * scale;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(image as CanvasImageSource, position.x - drawWidth / 2, position.y - drawHeight / 2, drawWidth, drawHeight);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(position.x, position.y);
  ctx.scale(scale, scale);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 22px "${settings.customFont ?? 'Nunito'}", sans-serif`;
  ctx.fillStyle = gradeColor(snapshot.latestJudgement.grade);
  ctx.shadowColor = gradeColor(snapshot.latestJudgement.grade);
  ctx.shadowBlur = 16;
  ctx.fillText(gradeLabel(snapshot.latestJudgement.grade), 0, 0);
  ctx.restore();
}

function drawHud(
  ctx: DrawingContext,
  snapshot: FrameSnapshot,
  width: number,
  height: number,
  settings: RenderSettings,
): void {
  const font = settings.customFont ?? 'Nunito';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 6;

  const scorePos = hudPosition(settings.hudScore, width, height);
  ctx.font = `700 ${Math.max(12, Math.round(28 * settings.hudScore.scale))}px "${font}", sans-serif`;
  ctx.textAlign = settings.hudScore.anchor.endsWith('r') ? 'right' : settings.hudScore.anchor.endsWith('l') ? 'left' : 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(String(Math.round(snapshot.score.score)).padStart(8, '0'), scorePos.x, scorePos.y);

  const accPos = hudPosition(settings.hudAcc, width, height);
  ctx.font = `700 ${Math.max(10, Math.round(16 * settings.hudAcc.scale))}px "${font}", sans-serif`;
  ctx.textAlign = settings.hudAcc.anchor.endsWith('r') ? 'right' : settings.hudAcc.anchor.endsWith('l') ? 'left' : 'center';
  ctx.fillStyle = '#d6d9e0';
  ctx.fillText(`${(snapshot.score.accuracy * 100).toFixed(2)}%`, accPos.x, accPos.y);

  if (snapshot.score.combo > 1) {
    const comboPos = hudPosition(settings.hudCombo, width, height);
    ctx.font = `700 ${Math.max(14, Math.round(36 * settings.hudCombo.scale))}px "${font}", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(255,255,255,0.25)';
    ctx.shadowBlur = 16;
    ctx.fillText(`${snapshot.score.combo}x`, comboPos.x, comboPos.y);
  }

  ctx.restore();
}

export function renderFrame(
  ctx: DrawingContext,
  timeline: ReplayTimeline,
  snapshot: FrameSnapshot,
  settings: RenderSettings,
  width: number,
  height: number,
  noteskin: NoteskinSet<unknown>,
  background: unknown,
): void {
  ctx.clearRect(0, 0, width, height);
  drawBackground(ctx, width, height, settings, background);
  ctx.save();
  ctx.globalAlpha = settings.playFieldOpacity;
  drawPlayfield(ctx, timeline.beatmap, snapshot, width, height, settings);
  drawNotes(ctx, timeline, snapshot, width, height, settings, noteskin);
  drawReceptors(ctx, timeline.beatmap, snapshot, width, height, settings, noteskin);
  ctx.restore();
  drawJudgeFlash(ctx, snapshot, width, height, settings, noteskin);
  drawHud(ctx, snapshot, width, height, settings);
}
