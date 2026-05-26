import { NOTESKIN_ASSETS } from '../../noteskin_assets.js';
import type { NoteskinSet } from './types';

export interface NamedSource<T> {
  name: string;
  source: T;
}

export type NoteskinCropper<I> = (
  image: I,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
) => Promise<I | null>;

function createEmptyNoteskin<T>(name: string): NoteskinSet<T> {
  return {
    name,
    tapNotes: {},
    receptorsGo: {},
    receptorsPress: {},
    holdBody: null,
    holdCap: null,
    holdTail: null,
    mine: null,
    lift: null,
    judgements: {},
  };
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

function dirName(path: string): string {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/');
}

// ─── Simple filename matching (used by CLI generic path) ─────────────────────

/** Normalize a filename for fuzzy matching: lowercase, underscores↔spaces, strip parens. */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/_/g, ' ').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function findSource<T>(sources: NamedSource<T>[], candidates: string[]): T | null {
  // Build two lookup sets: exact lowercase, and normalized
  const exact = new Set(candidates.map((c) => c.toLowerCase()));
  const norm  = new Set(candidates.map((c) => normalizeName(c)));
  for (const source of sources) {
    const name = baseName(source.name).toLowerCase();
    if (exact.has(name)) return source.source;
    const nameNorm = normalizeName(name);
    if (norm.has(nameNorm)) return source.source;
  }
  return null;
}

function findSourceContaining<T>(sources: NamedSource<T>[], ...keywords: string[]): T | null {
  const kw = keywords.map((k) => k.toLowerCase());
  for (const source of sources) {
    const rawName = baseName(source.name);
    if (!/\.(png|webp|jpg|jpeg)$/i.test(rawName)) continue;
    // Match against both original and underscore-normalized name
    const name = rawName.toLowerCase();
    const nameNorm = normalizeName(name);
    if (kw.every((k) => name.includes(k) || nameNorm.includes(k))) return source.source;
  }
  return null;
}

function findJudgementStripSource<T>(sources: NamedSource<T>[]): T | null {
  for (const source of sources) {
    const name = source.name.toLowerCase();
    if (!/\.(png|webp|jpg|jpeg)$/i.test(name)) continue;
    if (!name.includes('1x6')) continue;
    if (name.includes('judg') || name.includes('judge') || name.includes('gbp') || name.includes('normal')) {
      return source.source;
    }
  }
  return null;
}

async function maybeLoad<T, I>(source: T | null, loader: (source: T) => Promise<I | null>): Promise<I | null> {
  if (source == null) return null;
  return loader(source);
}

// ─── Bitmap utilities ────────────────────────────────────────────────────────

/** Rotate an ImageBitmap by degrees (multiple of 90). Returns a NEW bitmap. */
async function rotateBitmap(image: ImageBitmap, degrees: number): Promise<ImageBitmap> {
  const norm = ((degrees % 360) + 360) % 360;
  if (norm === 0) return image;
  const rad = (norm * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const w = Math.round(image.width * cos + image.height * sin);
  const h = Math.round(image.width * sin + image.height * cos);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.drawImage(image, -image.width / 2, -image.height / 2);
  return createImageBitmap(canvas);
}

/** Extract frame 0 of a sprite sheet. NxM in filename = cols×rows. */
async function extractFirstFrame(image: ImageBitmap, filename: string): Promise<ImageBitmap> {
  const match = baseName(filename).match(/(\d+)x(\d+)/i);
  if (!match) return image;
  const cols = parseInt(match[1], 10);
  const rows = parseInt(match[2], 10);
  if (cols <= 1 && rows <= 1) return image;
  const frameW = Math.floor(image.width / cols);
  const frameH = Math.floor(image.height / rows);
  if (frameW <= 0 || frameH <= 0) return image;
  return createImageBitmap(image, 0, 0, frameW, frameH);
}

async function loadFile(file: File): Promise<ImageBitmap | null> {
  if (!/\.(png|webp|jpg|jpeg)$/i.test(file.name)) return null;
  try { return await createImageBitmap(file); } catch { return null; }
}

async function loadFileAndExtract(file: File): Promise<ImageBitmap | null> {
  const bmp = await loadFile(file);
  if (!bmp) return null;
  return extractFirstFrame(bmp, file.name);
}

// ─── metrics.ini parser ───────────────────────────────────────────────────────

interface MetricsInfo {
  /** Sprite sheet rows for tap note (from TapNoteNoteColorTextureCoordSpacingY) */
  tapNoteRows: number;
  /** Sprite sheet rows for mine */
  mineRows: number;
}

function parseMetricsIni(text: string): MetricsInfo {
  const result: MetricsInfo = { tapNoteRows: 1, mineRows: 8 };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (key === 'tapnotenotecolortexturecoordspacingy') {
      const spacing = parseFloat(val);
      if (spacing > 0) result.tapNoteRows = Math.round(1 / spacing);
    }
    if (key === 'tapminenotecolortexturecoordspacingy') {
      const spacing = parseFloat(val);
      if (spacing > 0) result.mineRows = Math.round(1 / spacing);
    }
  }
  return result;
}

// ─── NoteSkin.lua parser ──────────────────────────────────────────────────────
// We do a best-effort static parse — no Lua VM needed. We extract the tables
// that all USW-style skins define: ButtonRedir, Rotate, ElementRedir, Blank.

interface LuaSkinInfo {
  /** e.g. { Up: "Down", Left: "Down", Right: "Down", Down: "Down" } */
  buttonRedir: Record<string, string>;
  /** Rotation degrees per direction */
  rotate: Record<string, number>;
  /** Which elements should render as blank (invisible) */
  blank: Record<string, boolean>;
}

function parseLuaTable(lua: string, tableName: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Match: USWN.TableName = { ... } or local x = { ... } assigned to USWN.TableName
  const blockRe = new RegExp(
    `${tableName}\\s*=\\s*\\{([^}]*)\\}`,
    'is',
  );
  const m = lua.match(blockRe);
  if (!m) return result;
  const block = m[1];
  // Match: ["Key Name"] = "Value" or Key = "Value" or Key = number
  const pairRe = /\[?"([^"]+)"\]?\s*=\s*["']?([^,"'\n\r}]+)["']?|(\w+)\s*=\s*["']?([^,"'\n\r}]+)["']?/g;
  let pair: RegExpExecArray | null;
  while ((pair = pairRe.exec(block)) !== null) {
    const key = (pair[1] ?? pair[3])?.trim();
    const val = (pair[2] ?? pair[4])?.trim();
    if (key && val) result[key] = val;
  }
  return result;
}

function parseNoteSkinLua(lua: string): LuaSkinInfo {
  const buttonRedirRaw = parseLuaTable(lua, 'USWN\\.ButtonRedir');
  const rotateRaw = parseLuaTable(lua, 'USWN\\.Rotate');
  const blankRaw = parseLuaTable(lua, 'USWN\\.Blank');

  const buttonRedir: Record<string, string> = {};
  for (const [k, v] of Object.entries(buttonRedirRaw)) {
    buttonRedir[k.toLowerCase()] = v.toLowerCase();
  }

  const rotate: Record<string, number> = { left: 90, down: 0, up: 180, right: -90 };
  for (const [k, v] of Object.entries(rotateRaw)) {
    const deg = parseFloat(v);
    if (!isNaN(deg)) rotate[k.toLowerCase()] = deg;
  }

  const blank: Record<string, boolean> = {};
  for (const k of Object.keys(blankRaw)) {
    blank[k.toLowerCase()] = true;
  }

  return { buttonRedir, rotate, blank };
}

// ─── File map builder ─────────────────────────────────────────────────────────
// Given all uploaded files, build a map: lowercase(filename without ext) → File
// Also returns the root folder name and any helper text files.

interface SkinFileMap {
  /** lowercase baseName (no ext) → File */
  byName: Map<string, File>;
  /** All image files */
  images: File[];
  /** metrics.ini content if present */
  metricsText: string | null;
  /** NoteSkin.lua content if present */
  luaText: string | null;
  /** Root skin folder name */
  skinName: string;
}

async function buildSkinFileMap(files: File[]): Promise<SkinFileMap> {
  const byName = new Map<string, File>();
  const images: File[] = [];
  let metricsText: string | null = null;
  let luaText: string | null = null;
  const skinName = files[0]?.webkitRelativePath?.split('/')[0]
    ?? files[0]?.name ?? 'custom';

  for (const file of files) {
    const name = baseName(file.webkitRelativePath || file.name);
    const lower = name.toLowerCase();

    if (/\.(png|webp|jpg|jpeg)$/i.test(lower)) {
      images.push(file);
      // Index by full base name (no ext) — lowercase
      const noExt = lower.replace(/\.(png|webp|jpg|jpeg)$/i, '');
      byName.set(noExt, file);
      // Normalize underscores → spaces so "_Up_Go_Receptor_1x1_res_64x64" matches
      // candidate strings built with spaces like "_up go receptor 1x1 (res 64x64)"
      const spaced = noExt.replace(/_/g, ' ');
      if (spaced !== noExt) byName.set(spaced, file);
      // Also normalize (res NxN) ↔ (doubleres) variants and strip trailing parens
      const stripped = noExt
        .replace(/^_/, '')
        .replace(/_/g, ' ')
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim();
      if (stripped !== noExt) byName.set(stripped, file);
      const strippedSpaced = spaced.replace(/^_/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (strippedSpaced !== stripped && strippedSpaced !== noExt) byName.set(strippedSpaced, file);
    }

    if (lower === 'metrics.ini') {
      metricsText = await file.text();
    }
    if (lower === 'noteskin.lua') {
      luaText = await file.text();
    }
  }

  return { byName, images, metricsText, luaText, skinName };
}

// ─── USW-aware skin loader ────────────────────────────────────────────────────

/** Resolve a (direction, element) pair to a File using the lua skin info. */
function resolveFile(
  map: SkinFileMap,
  luaInfo: LuaSkinInfo,
  dir: string,         // e.g. "down"
  element: string,     // e.g. "tap note"
): File | null {
  // Canonical direction from ButtonRedir
  const canonDir = luaInfo.buttonRedir[dir] ?? dir;

  // Build candidate key patterns (lowercase, no ext):
  // USW standard: "_<Dir> <Element> [NxM] [(doubleres)]"
  // Also without leading underscore, with/without (doubleres)
  const titleDir = canonDir.charAt(0).toUpperCase() + canonDir.slice(1);
  const titleElem = element.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const patterns: string[] = [
    // Exact USW name patterns
    `_${canonDir} ${element}`,
    `_${titleDir} ${titleElem}`,
    `${canonDir} ${element}`,
    `${titleDir} ${titleElem}`,
    // Without spaces
    `${canonDir}_${element.replace(/ /g, '_')}`,
    // With common suffixes stripped
    `_${canonDir} ${element} 1x1 (res 64x64)`,
    `_${titleDir} ${titleElem} 1x1 (res 64x64)`,
    `_${canonDir} ${element} 1x1`,
    `_${titleDir} ${titleElem} 1x1`,
  ];

  for (const p of patterns) {
    const lower = p.toLowerCase();
    if (map.byName.has(lower)) return map.byName.get(lower)!;
    // Try with (doubleres) suffix
    if (map.byName.has(`${lower} (doubleres)`)) return map.byName.get(`${lower} (doubleres)`)!;
    // Try underscore variant  
    const underscored = lower.replace(/ /g, '_');
    if (map.byName.has(underscored)) return map.byName.get(underscored)!;
    // Try normalized (strips parens, normalizes spaces)
    const norm = normalizeName(lower);
    if (map.byName.has(norm)) return map.byName.get(norm)!;
  }

  // Keyword fallback: file must contain direction and all element words
  const elemWords = element.split(' ');
  for (const img of map.images) {
    const n = baseName(img.webkitRelativePath || img.name).toLowerCase().replace(/\.(png|webp|jpg|jpeg)$/, '');
    if (!n.includes(canonDir)) continue;
    if (elemWords.every((w) => n.includes(w))) return img;
  }

  return null;
}

/** Load a skin file as bitmap, applying sprite-sheet extraction */
async function loadSkinBitmap(
  file: File | null,
  frameRows = 1,
  frameCols = 1,
): Promise<ImageBitmap | null> {
  if (!file) return null;
  const bmp = await loadFile(file);
  if (!bmp) return null;
  // Extract first frame from sprite sheet
  const rows = Math.max(1, frameRows);
  const cols = Math.max(1, frameCols);
  if (rows === 1 && cols === 1) return bmp;
  // Also check filename for NxM hint
  const filenameMatch = baseName(file.name).match(/(\d+)x(\d+)/i);
  const fCols = filenameMatch ? parseInt(filenameMatch[1], 10) : cols;
  const fRows = filenameMatch ? parseInt(filenameMatch[2], 10) : rows;
  if (fCols <= 1 && fRows <= 1) return bmp;
  const fw = Math.floor(bmp.width / fCols);
  const fh = Math.floor(bmp.height / fRows);
  if (fw <= 0 || fh <= 0) return bmp;
  try { return await createImageBitmap(bmp, 0, 0, fw, fh); } catch { return bmp; }
}

// ─── Main browser noteskin builder ───────────────────────────────────────────

export async function buildCustomNoteskinBitmaps(
  files: File[],
  extraFiles: File[] = [],
): Promise<NoteskinSet<ImageBitmap>> {
  const allFiles = [...files, ...extraFiles];
  const map = await buildSkinFileMap(allFiles);

  const metrics = map.metricsText ? parseMetricsIni(map.metricsText) : { tapNoteRows: 1, mineRows: 8 };
  const luaInfo = map.luaText
    ? parseNoteSkinLua(map.luaText)
    : {
        // No lua: try to detect rotation from file presence
        buttonRedir: buildFallbackButtonRedir(map),
        rotate: { left: 90, down: 0, up: 180, right: -90 },
        blank: {},
      };

  const noteskin = createEmptyNoteskin<ImageBitmap>(map.skinName);
  const dirs = ['left', 'down', 'up', 'right'] as const;
  const dirUpper = { left: 'Left', down: 'Down', up: 'Up', right: 'Right' } as const;

  // Track which bitmaps we've already decoded so we can clone instead of
  // re-decode for directions that share the same source file.
  const bitmapCache = new Map<File, ImageBitmap>();
  async function getBitmap(file: File, rows = 1, cols = 1): Promise<ImageBitmap | null> {
    if (!bitmapCache.has(file)) {
      const bmp = await loadSkinBitmap(file, rows, cols);
      if (!bmp) return null;
      bitmapCache.set(file, bmp);
    }
    return bitmapCache.get(file)!;
  }

  // ── Tap notes ──
  for (const dir of dirs) {
    const file = resolveFile(map, luaInfo, dir, 'tap note');
    const srcBmp = file ? await getBitmap(file, metrics.tapNoteRows, 1) : null;
    if (!srcBmp) { noteskin.tapNotes[dirUpper[dir]] = null; continue; }
    const rot = luaInfo.rotate[dir] ?? 0;
    noteskin.tapNotes[dirUpper[dir]] =
      rot !== 0 ? await rotateBitmap(await cloneBitmap(srcBmp), rot) : await cloneBitmap(srcBmp);
  }

  // ── Receptors ──
  // Shared _receptor.png fallback
  const sharedReceptorFile = map.byName.get('_receptor') ?? map.byName.get('receptor') ?? null;

  for (const dir of dirs) {
    const goFile = resolveFile(map, luaInfo, dir, 'receptor')
      ?? resolveFile(map, luaInfo, dir, 'go receptor')
      ?? sharedReceptorFile;
    const pressFile = resolveFile(map, luaInfo, dir, 'press receptor')
      ?? resolveFile(map, luaInfo, dir, 'receptor')
      ?? sharedReceptorFile;

    const rot = luaInfo.rotate[dir] ?? 0;

    const goBmp = goFile ? await getBitmap(goFile) : null;
    const pressBmp = pressFile ? await getBitmap(pressFile) : null;

    noteskin.receptorsGo[dirUpper[dir]] =
      goBmp ? (rot !== 0 ? await rotateBitmap(await cloneBitmap(goBmp), rot) : await cloneBitmap(goBmp)) : null;
    noteskin.receptorsPress[dirUpper[dir]] =
      pressBmp ? (rot !== 0 ? await rotateBitmap(await cloneBitmap(pressBmp), rot) : await cloneBitmap(pressBmp)) : null;
  }

  // ── Hold body ── (not rotated, direction-independent in rendering)
  {
    const bodyFile =
      resolveFile(map, luaInfo, 'up', 'hold body active')
      ?? resolveFile(map, luaInfo, 'down', 'hold body active')
      ?? resolveFile(map, luaInfo, 'up', 'hold body')
      ?? resolveFile(map, luaInfo, 'down', 'hold body')
      ?? findSourceContaining(
           allFiles.map((f) => ({ name: f.webkitRelativePath || f.name, source: f })),
           'hold', 'body', 'active',
         )
      ?? findSourceContaining(
           allFiles.map((f) => ({ name: f.webkitRelativePath || f.name, source: f })),
           'hold', 'body',
         );
    noteskin.holdBody = bodyFile ? await loadFile(bodyFile) : null;
  }

  // ── Hold cap (BottomCap) ──
  {
    const capFile =
      resolveFile(map, luaInfo, 'up', 'hold bottomcap active')
      ?? resolveFile(map, luaInfo, 'down', 'hold bottomcap active')
      ?? resolveFile(map, luaInfo, 'up', 'hold bottomcap')
      ?? resolveFile(map, luaInfo, 'down', 'hold bottomcap')
      ?? resolveFile(map, luaInfo, 'up', 'hold topcap active')
      ?? findSourceContaining(
           allFiles.map((f) => ({ name: f.webkitRelativePath || f.name, source: f })),
           'hold', 'bottomcap', 'active',
         )
      ?? findSourceContaining(
           allFiles.map((f) => ({ name: f.webkitRelativePath || f.name, source: f })),
           'hold', 'bottomcap',
         )
      ?? findSourceContaining(
           allFiles.map((f) => ({ name: f.webkitRelativePath || f.name, source: f })),
           'hold', 'cap',
         );
    noteskin.holdCap = capFile ? await loadFile(capFile) : null;
    // holdTail is a separate clone — NEVER the same object reference (would double-transfer)
    noteskin.holdTail = capFile ? await loadFile(capFile) : null;
  }

  // ── Mine ──
  {
    const mineFile =
      resolveFile(map, luaInfo, 'down', 'tap mine')
      ?? map.byName.get('_down tap mine 8x1')
      ?? map.byName.get('mine 8x1')
      ?? map.byName.get('mine')
      ?? findSourceContaining(
           allFiles.map((f) => ({ name: f.webkitRelativePath || f.name, source: f })),
           'mine',
         );
    noteskin.mine = mineFile ? await loadSkinBitmap(mineFile, metrics.mineRows, 1) : null;
  }

  // ── Lift ──
  {
    const liftFile = map.byName.get('lift') ?? null;
    noteskin.lift = liftFile ? await loadFile(liftFile) : null;
  }

  // ── Judgements ──
  const judgeNames: Array<[keyof NoteskinSet<ImageBitmap>['judgements'], string[]]> = [
    ['w1', ['w1', 'marvelous', 'fantastic', 'judgment_perfect']],
    ['w2', ['w2', 'perfect', 'judgment_great']],
    ['w3', ['w3', 'great', 'judgment_good']],
    ['w4', ['w4', 'good', 'judgment_ok']],
    ['w5', ['w5', 'boo', 'judgment_meh']],
    ['miss', ['miss', 'judgment_miss', 'ng']],
  ];
  const imgSources = allFiles.map((f) => ({ name: f.webkitRelativePath || f.name, source: f }));
  for (const [key, candidates] of judgeNames) {
    const file = findSource(imgSources, candidates.map((c) => `${c}.png`));
    noteskin.judgements[key] = file ? await loadFile(file) : null;
  }

  // Judgement strip fallback
  const missing = judgeNames.filter(([k]) => !noteskin.judgements[k]);
  if (missing.length > 0) {
    const stripFile = findJudgementStripSource(imgSources);
    if (stripFile) {
      const strip = await loadFile(stripFile);
      if (strip) {
        const sliceH = strip.height / 6;
        const keys = ['w1', 'w2', 'w3', 'w4', 'w5', 'miss'] as const;
        for (let i = 0; i < keys.length; i++) {
          if (noteskin.judgements[keys[i]]) continue;
          try {
            noteskin.judgements[keys[i]] = await createImageBitmap(strip, 0, i * sliceH, strip.width, sliceH);
          } catch { /* skip */ }
        }
      }
    }
  }

  return noteskin;
}

/** When no NoteSkin.lua is present, infer if it's a Down-canonical skin */
function buildFallbackButtonRedir(map: SkinFileMap): Record<string, string> {
  const names = [...map.byName.keys()];
  const hasDown = names.some((n) => n.includes('down'));
  const hasUp   = names.some((n) => n.includes('up') && n.includes('tap'));
  const hasLeft  = names.some((n) => n.includes('left') && n.includes('tap'));
  if (hasDown && !hasUp && !hasLeft) {
    return { up: 'down', down: 'down', left: 'down', right: 'down' };
  }
  return {};
}

/** Clone a bitmap by drawing to a new OffscreenCanvas */
async function cloneBitmap(src: ImageBitmap): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(src.width, src.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  return createImageBitmap(canvas);
}

// ─── Default noteskin (built-in assets) ──────────────────────────────────────

async function createBitmapFromDataUrl(src: string | File): Promise<ImageBitmap | null> {
  try {
    if (typeof src !== 'string') return await createImageBitmap(src as File);
    const response = await fetch(src);
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch { return null; }
}

async function cropBitmap(
  image: ImageBitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): Promise<ImageBitmap | null> {
  try { return await createImageBitmap(image, sx, sy, sw, sh); } catch { return null; }
}

export async function buildDefaultNoteskinBitmaps(): Promise<NoteskinSet<ImageBitmap>> {
  // The default skin (AmbieZeroTwo) has per-direction assets with no lua file.
  // We construct a synthetic SkinFileMap from the embedded data-URL assets so
  // the full browser loader (with rotation-aware resolveFile) can be used.
  const sources: NamedSource<string>[] = [
    ...Object.entries(NOTESKIN_ASSETS).map(([name, source]) => ({ name, source })),
    { name: 'default-judgement-strip.png', source: '/judgements/default-judgement-strip.png' },
  ];

  // Build a file-like map keyed the same way buildSkinFileMap does for real files
  const byName = new Map<string, string>();
  const images: string[] = [];
  for (const { name, source } of sources) {
    const base = baseName(name);
    const lower = base.toLowerCase();
    if (/\.(png|webp|jpg|jpeg)$/i.test(lower)) {
      images.push(source);
      const noExt = lower.replace(/\.(png|webp|jpg|jpeg)$/i, '');
      byName.set(noExt, source);
      const spaced = noExt.replace(/_/g, ' ');
      if (spaced !== noExt) byName.set(spaced, source);
      const stripped = noExt.replace(/^_/, '').replace(/_/g, ' ').replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (stripped !== noExt) byName.set(stripped, source);
      const strippedSpaced = spaced.replace(/^_/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
      if (strippedSpaced !== stripped && strippedSpaced !== noExt) byName.set(strippedSpaced, source);
      const norm = normalizeName(noExt);
      if (!byName.has(norm)) byName.set(norm, source);
    }
  }

  // Synthetic map — uses string URLs as the "File" type
  const map = {
    byName,
    images: images.map((src) => ({ name: src, source: src })),
    metricsText: null,
    luaText: null,
    skinName: 'AmbieZeroTwo',
  } as unknown as SkinFileMap;

  // No lua: default skin has explicit per-direction files, no rotation needed
  const luaInfo: LuaSkinInfo = {
    buttonRedir: {}, // no redirection — each direction has its own file
    rotate: { left: 0, down: 0, up: 0, right: 0 }, // no rotation applied
    blank: {},
  };

  // Use a string-URL-aware loader
  async function loadUrl(src: string | File): Promise<ImageBitmap | null> {
    return createBitmapFromDataUrl(src as string);
  }

  const noteskin = createEmptyNoteskin<ImageBitmap>('AmbieZeroTwo');
  const dirs = ['left', 'down', 'up', 'right'] as const;
  const dirUpper = { left: 'Left', down: 'Down', up: 'Up', right: 'Right' } as const;

  // Tap notes
  for (const dir of dirs) {
    const file = resolveFile(map, luaInfo, dir, 'tap note');
    noteskin.tapNotes[dirUpper[dir]] = file ? await loadAndExtractFrameFromUrl(file as unknown as string, '') : null;
  }

  // Receptors
  for (const dir of dirs) {
    const goFile = resolveFile(map, luaInfo, dir, 'go receptor') ?? resolveFile(map, luaInfo, dir, 'receptor');
    const pressFile = resolveFile(map, luaInfo, dir, 'press receptor') ?? goFile;
    noteskin.receptorsGo[dirUpper[dir]]    = goFile    ? await createBitmapFromDataUrl(goFile    as unknown as string) : null;
    noteskin.receptorsPress[dirUpper[dir]] = pressFile ? await createBitmapFromDataUrl(pressFile as unknown as string) : null;
  }

  // Holds
  const bodyFile = resolveFile(map, luaInfo, 'up', 'hold body active') ?? resolveFile(map, luaInfo, 'up', 'hold body');
  noteskin.holdBody = bodyFile ? await createBitmapFromDataUrl(bodyFile as unknown as string) : null;

  const capFile = resolveFile(map, luaInfo, 'up', 'hold bottomcap active')
    ?? resolveFile(map, luaInfo, 'up', 'hold bottomcap')
    ?? resolveFile(map, luaInfo, 'up', 'hold topcap active');
  noteskin.holdCap  = capFile ? await createBitmapFromDataUrl(capFile as unknown as string) : null;
  noteskin.holdTail = capFile ? await createBitmapFromDataUrl(capFile as unknown as string) : null;

  // Mine — 8x1 sprite sheet
  const mineFile = resolveFile(map, luaInfo, '', 'mine 8x1') ?? resolveFile(map, luaInfo, '', 'mine');
  if (mineFile) {
    const mineBmp = await createBitmapFromDataUrl(mineFile as unknown as string);
    noteskin.mine = mineBmp ? await extractFirstFrame(mineBmp, 'mine 8x1') : null;
  }

  // Lift
  const liftFile = byName.get('misc/lift') ?? byName.get('lift');
  noteskin.lift = liftFile ? await createBitmapFromDataUrl(liftFile) : null;

  // Judgements via strip
  const stripSrc = findJudgementStripSource(sources);
  if (stripSrc) {
    const strip = await createBitmapFromDataUrl(stripSrc);
    if (strip) {
      const sliceH = strip.height / 6;
      const keys = ['w1', 'w2', 'w3', 'w4', 'w5', 'miss'] as const;
      for (let i = 0; i < keys.length; i++) {
        try { noteskin.judgements[keys[i]] = await createImageBitmap(strip, 0, i * sliceH, strip.width, sliceH); }
        catch { /* skip */ }
      }
    }
  }

  return noteskin;
}

async function loadAndExtractFrameFromUrl(src: string, filename: string): Promise<ImageBitmap | null> {
  const bmp = await createBitmapFromDataUrl(src);
  if (!bmp) return null;
  return extractFirstFrame(bmp, filename || src);
}

// ─── Generic noteskin builder (CLI / non-browser) ────────────────────────────

export async function buildNoteskinFromSources<T, I>(
  name: string,
  sources: NamedSource<T>[],
  loader: (source: T) => Promise<I | null>,
  cropper?: NoteskinCropper<I>,
): Promise<NoteskinSet<I>> {
  const noteskin = createEmptyNoteskin<I>(name);
  const dirs = [
    { lower: 'left', upper: 'Left' as const },
    { lower: 'down', upper: 'Down' as const },
    { lower: 'up',   upper: 'Up'   as const },
    { lower: 'right', upper: 'Right' as const },
  ];
  const fs = (cands: string[]) => findSource(sources, cands);
  for (const dir of dirs) {
    noteskin.tapNotes[dir.upper] = await maybeLoad(
      fs([`_${dir.lower} tap note 1x1 (res 64x64).png`, `_${dir.lower} tap note 1x1.png`,
          `${dir.lower} tap note.png`, `tap_${dir.lower}.png`, `${dir.lower}.png`]),
      loader,
    );
    noteskin.receptorsGo[dir.upper] = await maybeLoad(
      fs([`_${dir.lower} go receptor 1x1 (res 64x64).png`, `_${dir.lower} go receptor 1x1.png`,
          `${dir.lower} go receptor.png`, `receptor_${dir.lower}.png`]),
      loader,
    );
    noteskin.receptorsPress[dir.upper] = await maybeLoad(
      fs([`_${dir.lower} press receptor 1x1 (res 64x64).png`, `_${dir.lower} press receptor 1x1.png`,
          `${dir.lower} press receptor.png`, `receptor_${dir.lower}_press.png`]),
      loader,
    );
  }
  noteskin.holdBody = await maybeLoad(
    fs(['up hold body active (doubleres).png', 'down hold body active (doubleres).png',
        'hold body.png', 'hold_body.png']),
    loader,
  );
  const capSrc = fs(['up hold bottomcap active (doubleres).png', 'down hold bottomcap active (doubleres).png',
                     'up hold bottomcap active.png', 'down hold bottomcap active.png',
                     'hold cap.png', 'hold_cap.png']);
  noteskin.holdCap = await maybeLoad(capSrc, loader);
  noteskin.holdTail = await maybeLoad(capSrc, loader); // separate load = separate object
  noteskin.mine = await maybeLoad(fs(['mine 8x1.png', 'mine.png', '_down tap mine 8x1.png']), loader);
  noteskin.lift = await maybeLoad(fs(['lift.png']), loader);
  noteskin.judgements.w1   = await maybeLoad(fs(['w1.png', 'marvelous.png', 'fantastic.png']), loader);
  noteskin.judgements.w2   = await maybeLoad(fs(['w2.png', 'perfect.png']), loader);
  noteskin.judgements.w3   = await maybeLoad(fs(['w3.png', 'great.png']), loader);
  noteskin.judgements.w4   = await maybeLoad(fs(['w4.png', 'good.png']), loader);
  noteskin.judgements.w5   = await maybeLoad(fs(['w5.png', 'boo.png']), loader);
  noteskin.judgements.miss = await maybeLoad(fs(['miss.png', 'ng.png']), loader);
  if (cropper) {
    const strip = await maybeLoad(findJudgementStripSource(sources), loader);
    if (strip) {
      const sw = Number((strip as { width?: number }).width ?? 0);
      const sh = Number((strip as { height?: number }).height ?? 0);
      const sliceH = sh >= 6 ? sh / 6 : 0;
      if (sw > 0 && sliceH > 0) {
        const keys: Array<keyof NoteskinSet<I>['judgements']> = ['w1', 'w2', 'w3', 'w4', 'w5', 'miss'];
        for (let i = 0; i < keys.length; i++) {
          if (noteskin.judgements[keys[i]]) continue;
          noteskin.judgements[keys[i]] = await cropper(strip, 0, i * sliceH, sw, sliceH);
        }
      }
    }
  }
  return noteskin;
}

// ─── Transferables collection ─────────────────────────────────────────────────

export function collectBitmapTransferables(
  noteskin: NoteskinSet<ImageBitmap> | null,
  background: ImageBitmap | null,
): Transferable[] {
  const transferables: Transferable[] = [];
  const seen = new Set<ImageBitmap>();

  function add(bmp: ImageBitmap | null | undefined): void {
    if (bmp && !seen.has(bmp)) {
      seen.add(bmp);
      transferables.push(bmp);
    }
  }

  if (background) add(background);
  if (!noteskin) return transferables;

  for (const bucket of [noteskin.tapNotes, noteskin.receptorsGo, noteskin.receptorsPress, noteskin.judgements]) {
    for (const image of Object.values(bucket)) add(image as ImageBitmap | null);
  }
  add(noteskin.holdBody);
  add(noteskin.holdCap);
  add(noteskin.holdTail);
  add(noteskin.mine);
  add(noteskin.lift);

  return transferables;
}

export type { NoteskinSet };
