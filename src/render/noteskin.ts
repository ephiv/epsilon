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

// ─── Path helpers ─────────────────────────────────────────────────────────────

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Lowercase, underscores→spaces, collapse whitespace, strip parenthetical suffixes. */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── File map ─────────────────────────────────────────────────────────────────

interface SkinFileMap {
  /** Multiple normalized keys → File (or string URL for default skin) */
  byName: Map<string, File | string>;
  images: Array<{ relPath: string; file: File | string }>;
  metricsText: string | null;
  luaText: string | null;
  skinName: string;
}

async function buildSkinFileMap(files: File[]): Promise<SkinFileMap> {
  const byName = new Map<string, File | string>();
  const images: Array<{ relPath: string; file: File | string }> = [];
  let metricsText: string | null = null;
  let luaText: string | null = null;
  const skinName =
    files[0]?.webkitRelativePath?.split('/')[0] ?? files[0]?.name ?? 'custom';

  for (const file of files) {
    const relPath = file.webkitRelativePath || file.name;
    const lower = relPath.toLowerCase();

    if (lower.endsWith('metrics.ini')) metricsText = await file.text();
    if (lower.endsWith('noteskin.lua')) luaText = await file.text();

    if (!/\.(png|webp|jpg|jpeg)$/i.test(lower)) continue;

    images.push({ relPath, file });

    // Index under several normalized key variants so any reasonable lookup hits
    const base = baseName(relPath);
    const noExt = base.replace(/\.(png|webp|jpg|jpeg)$/i, '');

    const variants = new Set<string>();
    variants.add(noExt.toLowerCase());
    variants.add(normalizeName(noExt));
    // strip leading underscore
    variants.add(normalizeName(noExt.replace(/^_/, '')));
    // also include the sub-path relative to skin root, normalized
    const subPath = relPath.split('/').slice(1).join('/').replace(/\.(png|webp|jpg|jpeg)$/i, '');
    variants.add(subPath.toLowerCase());
    variants.add(normalizeName(subPath));

    for (const v of variants) {
      if (!byName.has(v)) byName.set(v, file);
    }
  }

  return { byName, images, metricsText, luaText, skinName };
}

// ─── Lua parser ───────────────────────────────────────────────────────────────

interface LuaSkinInfo {
  /** e.g. { up:"Up", down:"Up", left:"Up", right:"Up" } — values are original-case */
  buttonRedir: Record<string, string>;
  /** Rotation degrees per direction key (lowercase) */
  rotate: Record<string, number>;
  /** receptors/notes use sButton directly (not redirected) — true for USW skins */
  directLoad: boolean;
}

function parseLuaTable(lua: string, tableName: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Match TableName = { ... } or TableName =\n{ ... }
  const re = new RegExp(`${tableName}\\s*=\\s*\\{([^}]*)\\}`, 'is');
  const m = lua.match(re);
  if (!m) return result;
  const block = m[1];
  // Match ["Key"] = "Value" or Key = "Value" or Key = -90 etc.
  const pair = /\[?"?([A-Za-z][A-Za-z0-9 _]*)"?\]?\s*=\s*"?(-?[A-Za-z0-9_. ]+)"?/g;
  let p: RegExpExecArray | null;
  while ((p = pair.exec(block)) !== null) {
    const key = p[1].trim();
    const val = p[2].trim().replace(/[",;]/g, '');
    if (key && val) result[key] = val;
  }
  return result;
}

function parseNoteSkinLua(lua: string): LuaSkinInfo {
  const buttonRedirRaw = parseLuaTable(lua, 'USWN\\.ButtonRedir');
  const rotateRaw      = parseLuaTable(lua, 'USWN\\.Rotate');

  // Normalize keys to lowercase
  const buttonRedir: Record<string, string> = {};
  for (const [k, v] of Object.entries(buttonRedirRaw)) {
    buttonRedir[k.toLowerCase()] = v; // keep value original-case (it's a direction name)
  }

  const rotate: Record<string, number> = {};
  for (const [k, v] of Object.entries(rotateRaw)) {
    const deg = parseFloat(v);
    if (!isNaN(deg)) rotate[k.toLowerCase()] = deg;
  }

  // Detect USW direct-load pattern: the lua uses sButton (not Button) for
  // receptor/note texture paths. We detect this by checking if the lua source
  // contains createReceptor(sButton) or GetPath("Receptors/_"..direction
  const directLoad =
    lua.includes('createReceptor(sButton)') ||
    lua.includes('"Receptors/_"..direction') ||
    lua.includes('"Notes/_"..direction') ||
    lua.includes("NOTESKIN:GetPath(\"Receptors/_\"..direction");

  return { buttonRedir, rotate, directLoad };
}

function parseMetricsIni(text: string): { tapNoteRows: number; mineRows: number } {
  const result = { tapNoteRows: 1, mineRows: 8 };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (key === 'tapnotenotecolortexturecoordspacingy') {
      const s = parseFloat(val);
      if (s > 0) result.tapNoteRows = Math.round(1 / s);
    }
    if (key === 'tapminenotecolortexturecoordspacingy') {
      const s = parseFloat(val);
      if (s > 0) result.mineRows = Math.round(1 / s);
    }
  }
  return result;
}

// ─── File lookup ──────────────────────────────────────────────────────────────

function lookup(map: SkinFileMap, ...keys: string[]): File | string | null {
  for (const key of keys) {
    const k = normalizeName(key);
    if (map.byName.has(k)) return map.byName.get(k)!;
    // also try without leading underscore
    const stripped = k.replace(/^_\s*/, '');
    if (map.byName.has(stripped)) return map.byName.get(stripped)!;
  }
  return null;
}

/** Find a file whose normalized name contains ALL of the given keywords. */
function lookupContaining(map: SkinFileMap, ...keywords: string[]): File | string | null {
  const kw = keywords.map((k) => k.toLowerCase());
  for (const { relPath, file } of map.images) {
    const n = normalizeName(baseName(relPath));
    if (kw.every((k) => n.includes(k))) return file;
  }
  return null;
}

// ─── Bitmap helpers ───────────────────────────────────────────────────────────

async function loadBitmap(src: File | string | null): Promise<ImageBitmap | null> {
  if (src == null) return null;
  try {
    if (typeof src === 'string') {
      const r = await fetch(src);
      return createImageBitmap(await r.blob());
    }
    return await createImageBitmap(src as File);
  } catch { return null; }
}

async function extractFrame(bmp: ImageBitmap, rows: number, cols: number): Promise<ImageBitmap> {
  if (rows <= 1 && cols <= 1) return bmp;
  const fw = Math.floor(bmp.width / cols);
  const fh = Math.floor(bmp.height / rows);
  if (fw <= 0 || fh <= 0) return bmp;
  try { return await createImageBitmap(bmp, 0, 0, fw, fh); } catch { return bmp; }
}

async function rotateBitmap(bmp: ImageBitmap, deg: number): Promise<ImageBitmap> {
  const norm = ((deg % 360) + 360) % 360;
  if (norm === 0) return bmp;
  const rad = (norm * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const w = Math.round(bmp.width * cos + bmp.height * sin);
  const h = Math.round(bmp.width * sin + bmp.height * cos);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(rad);
  ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
  return createImageBitmap(canvas);
}

async function cloneBitmap(bmp: ImageBitmap): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return createImageBitmap(c);
}

// ─── Main browser noteskin builder ───────────────────────────────────────────

export async function buildCustomNoteskinBitmaps(
  files: File[],
  extraFiles: File[] = [],
): Promise<NoteskinSet<ImageBitmap>> {
  const map = await buildSkinFileMap([...files, ...extraFiles]);
  const metrics = map.metricsText ? parseMetricsIni(map.metricsText) : { tapNoteRows: 1, mineRows: 8 };
  const lua = map.luaText ? parseNoteSkinLua(map.luaText) : null;

  const noteskin = createEmptyNoteskin<ImageBitmap>(map.skinName);

  const dirs = [
    { key: 'left',  title: 'Left'  },
    { key: 'down',  title: 'Down'  },
    { key: 'up',    title: 'Up'    },
    { key: 'right', title: 'Right' },
  ] as const;

  // Cache decoded bitmaps keyed by file reference to avoid re-decoding the same
  // file multiple times (e.g. when all directions share one source file).
  const bmpCache = new Map<File | string, ImageBitmap>();
  async function decode(src: File | string | null): Promise<ImageBitmap | null> {
    if (!src) return null;
    if (!bmpCache.has(src)) {
      const b = await loadBitmap(src);
      if (!b) return null;
      bmpCache.set(src, b);
    }
    return bmpCache.get(src)!;
  }

  // ── TAP NOTES ──────────────────────────────────────────────────────────────
  // USW skins with directLoad: each direction loads its own file ("Notes/_Down Tap Note")
  // and rotation from USWN.Rotate is applied.
  // Non-directLoad / no-lua: same — each direction has its own pre-rotated file.
  for (const dir of dirs) {
    const titleDir = dir.title;
    const rotation = lua?.rotate[dir.key] ?? 0;

    // For directLoad skins: file is always the actual direction (not redirected)
    // For redirect skins: file comes from the redirected direction
    const srcDir = (lua && !lua.directLoad)
      ? (lua.buttonRedir[dir.key] ?? titleDir)
      : titleDir;

    const src =
      lookup(map,
        `Notes/_${srcDir} Tap Note 1x1 (res 64x64)`,
        `Notes/_${srcDir} Tap Note 1x1`,
        `Notes/_${srcDir} Tap Note`,
        `_${srcDir} Tap Note 1x1 (res 64x64)`,
        `_${srcDir} Tap Note`,
        `${srcDir} Tap Note`,
      ) ?? lookupContaining(map, srcDir.toLowerCase(), 'tap', 'note');

    const raw = await decode(src);
    if (!raw) { noteskin.tapNotes[titleDir] = null; continue; }
    const framed = await extractFrame(raw, metrics.tapNoteRows, 1);
    // Clone before rotate so cache entry stays intact
    const toRotate = rotation !== 0 ? await cloneBitmap(framed) : framed;
    noteskin.tapNotes[titleDir] = rotation !== 0 ? await rotateBitmap(toRotate, rotation) : toRotate;
  }

  // ── RECEPTORS ──────────────────────────────────────────────────────────────
  // USW directLoad: always uses actual direction for file path, then applies rotation.
  // Shared _receptor.png (e.g. AmbieWhite): one file, rotate per direction.
  const sharedReceptor =
    lookup(map, '_receptor', 'receptor') ??
    (map.images.length < 10 ? lookupContaining(map, 'receptor') : null);

  for (const dir of dirs) {
    const titleDir = dir.title;
    const rotation = lua?.rotate[dir.key] ?? 0;

    const srcDir = (lua && !lua.directLoad)
      ? (lua.buttonRedir[dir.key] ?? titleDir)
      : titleDir;

    const goSrc =
      lookup(map,
        `Receptors/_${srcDir} Go Receptor 1x1 (res 64x64)`,
        `Receptors/_${srcDir} Go Receptor 1x1`,
        `Receptors/_${srcDir} Go Receptor`,
        `_${srcDir} Go Receptor 1x1 (res 64x64)`,
        `_${srcDir} Go Receptor`,
        `${srcDir} Go Receptor`,
      ) ?? lookupContaining(map, srcDir.toLowerCase(), 'go', 'receptor')
        ?? lookupContaining(map, srcDir.toLowerCase(), 'receptor')
        ?? sharedReceptor;

    const pressSrc =
      lookup(map,
        `Receptors/_${srcDir} Press Receptor 1x1 (res 64x64)`,
        `Receptors/_${srcDir} Press Receptor 1x1`,
        `Receptors/_${srcDir} Press Receptor`,
        `_${srcDir} Press Receptor 1x1 (res 64x64)`,
        `_${srcDir} Press Receptor`,
        `${srcDir} Press Receptor`,
      ) ?? lookupContaining(map, srcDir.toLowerCase(), 'press', 'receptor')
        ?? goSrc;

    const goBmp    = await decode(goSrc);
    const pressBmp = await decode(pressSrc);

    async function applyRotation(bmp: ImageBitmap | null): Promise<ImageBitmap | null> {
      if (!bmp) return null;
      if (rotation === 0) return cloneBitmap(bmp);
      return rotateBitmap(await cloneBitmap(bmp), rotation);
    }

    noteskin.receptorsGo[titleDir]    = await applyRotation(goBmp);
    noteskin.receptorsPress[titleDir] = await applyRotation(pressBmp);
  }

  // ── HOLDS ──────────────────────────────────────────────────────────────────
  // Hold body/cap: always from the redirected direction (or Up as universal fallback)
  // Rotation is NOT applied to holds — they're vertical by design.
  const holdSrcDir = lua
    ? (lua.buttonRedir['up'] ?? lua.buttonRedir['down'] ?? 'Up')
    : 'Up';

  const bodyFile =
    lookup(map,
      `Holds/${holdSrcDir} Hold Body Active (doubleres)`,
      `Holds/${holdSrcDir} Hold Body Active`,
      `${holdSrcDir} Hold Body Active (doubleres)`,
      `${holdSrcDir} Hold Body Active`,
      `Hold Body Active (doubleres)`,
      `Hold Body`,
    ) ?? lookupContaining(map, 'hold', 'body', 'active')
      ?? lookupContaining(map, 'hold', 'body');

  noteskin.holdBody = await decode(bodyFile);

  const capFile =
    lookup(map,
      `Holds/${holdSrcDir} Hold BottomCap active (doubleres)`,
      `Holds/${holdSrcDir} Hold BottomCap Active (doubleres)`,
      `Holds/${holdSrcDir} Hold BottomCap active`,
      `Holds/${holdSrcDir} Hold BottomCap Active`,
      `${holdSrcDir} Hold BottomCap Active (doubleres)`,
      `${holdSrcDir} Hold BottomCap Active`,
      `Down Hold BottomCap Active (doubleres)`,
      `Down Hold BottomCap Active`,
    ) ?? lookupContaining(map, 'hold', 'bottomcap', 'active')
      ?? lookupContaining(map, 'hold', 'bottomcap')
      ?? lookupContaining(map, 'hold', 'cap');

  // Load cap and tail as separate ImageBitmap instances — NEVER the same object
  // reference, as both get transferred to the worker and a double-transfer throws.
  noteskin.holdCap  = await loadBitmap(capFile);
  noteskin.holdTail = await loadBitmap(capFile);

  // ── MINE ───────────────────────────────────────────────────────────────────
  const mineFile =
    lookup(map, 'Misc/Mine 8x1', 'Mine 8x1', '_Down Tap Mine 8x1') ??
    lookupContaining(map, 'mine');
  const mineBmp = await decode(mineFile);
  noteskin.mine = mineBmp ? await extractFrame(mineBmp, metrics.mineRows, 1) : null;

  // ── LIFT ───────────────────────────────────────────────────────────────────
  noteskin.lift = await loadBitmap(lookup(map, 'Misc/Lift', 'Lift'));

  // ── JUDGEMENTS ─────────────────────────────────────────────────────────────
  const judgeMap: Array<[keyof NoteskinSet<ImageBitmap>['judgements'], string[]]> = [
    ['w1',   ['w1.png', 'marvelous.png', 'fantastic.png']],
    ['w2',   ['w2.png', 'perfect.png']],
    ['w3',   ['w3.png', 'great.png']],
    ['w4',   ['w4.png', 'good.png']],
    ['w5',   ['w5.png', 'boo.png']],
    ['miss', ['miss.png', 'ng.png']],
  ];
  for (const [key, candidates] of judgeMap) {
    for (const c of candidates) {
      const f = lookup(map, c.replace('.png', ''));
      if (f) { noteskin.judgements[key] = await loadBitmap(f); break; }
    }
  }

  // Judgement strip fallback
  const missingJudge = judgeMap.filter(([k]) => !noteskin.judgements[k]);
  if (missingJudge.length > 0) {
    const stripFile = lookupContaining(map, '1x6');
    const strip = stripFile ? await loadBitmap(stripFile) : null;
    if (strip) {
      const sliceH = strip.height / 6;
      const keys = ['w1','w2','w3','w4','w5','miss'] as const;
      for (let i = 0; i < keys.length; i++) {
        if (noteskin.judgements[keys[i]]) continue;
        try { noteskin.judgements[keys[i]] = await createImageBitmap(strip, 0, i * sliceH, strip.width, sliceH); }
        catch { /* skip */ }
      }
    }
  }

  return noteskin;
}

// ─── Default (embedded) noteskin ─────────────────────────────────────────────

export async function buildDefaultNoteskinBitmaps(): Promise<NoteskinSet<ImageBitmap>> {
  // Build a synthetic SkinFileMap from the embedded data-URL assets.
  // AmbieZeroTwo is a USW skin with per-direction files and no rotation.
  const entries = [
    ...Object.entries(NOTESKIN_ASSETS),
    ['default-judgement-strip.png', '/judgements/default-judgement-strip.png'],
  ] as [string, string][];

  const byName = new Map<string, string>();
  const images: Array<{ relPath: string; file: string }> = [];

  for (const [name, src] of entries) {
    if (!/\.(png|webp|jpg|jpeg)$/i.test(name)) continue;
    images.push({ relPath: name, file: src });
    const noExt = name.replace(/\.(png|webp|jpg|jpeg)$/i, '');
    const variants = new Set<string>();
    variants.add(noExt.toLowerCase());
    variants.add(normalizeName(noExt));
    variants.add(normalizeName(noExt.replace(/^_/, '')));
    // sub-path (strip skin-root prefix — there is none for default assets)
    for (const v of variants) {
      if (!byName.has(v)) byName.set(v, src);
    }
  }

  const map: SkinFileMap = {
    byName: byName as Map<string, File | string>,
    images: images as Array<{ relPath: string; file: File | string }>,
    metricsText: null,
    luaText: null,
    skinName: 'AmbieZeroTwo',
  };

  // AmbieZeroTwo: per-direction files, no ButtonRedir redirection, zero rotation
  const lua: LuaSkinInfo = {
    buttonRedir: { up: 'Up', down: 'Down', left: 'Left', right: 'Right' },
    rotate:      { up: 0, down: 0, left: 0, right: 0 },
    directLoad:  true,
  };

  // Reuse buildCustomNoteskinBitmaps logic by synthesising File-like objects.
  // Simpler: just manually do the lookup using the helpers defined above.
  const noteskin = createEmptyNoteskin<ImageBitmap>('AmbieZeroTwo');
  const bmpCache = new Map<string, ImageBitmap>();

  async function decodeUrl(src: string | null): Promise<ImageBitmap | null> {
    if (!src) return null;
    if (!bmpCache.has(src)) {
      try {
        const r = await fetch(src);
        const b = await createImageBitmap(await r.blob());
        bmpCache.set(src, b);
      } catch { return null; }
    }
    return bmpCache.get(src)!;
  }

  function lookupMap(...keys: string[]): string | null {
    for (const key of keys) {
      const k = normalizeName(key);
      if (byName.has(k)) return byName.get(k)!;
      const stripped = k.replace(/^_\s*/, '');
      if (byName.has(stripped)) return byName.get(stripped)!;
    }
    return null;
  }

  const dirs = [
    { key: 'left',  title: 'Left'  },
    { key: 'down',  title: 'Down'  },
    { key: 'up',    title: 'Up'    },
    { key: 'right', title: 'Right' },
  ] as const;

  for (const dir of dirs) {
    const t = dir.title;
    noteskin.tapNotes[t] = await decodeUrl(lookupMap(
      `Notes/_${t} Tap Note 1x1 (res 64x64)`,
      `Notes/_${t} Tap Note 1x1`,
      `_${t} Tap Note 1x1 (res 64x64)`,
    ));
    noteskin.receptorsGo[t] = await decodeUrl(lookupMap(
      `Receptors/_${t} Go Receptor 1x1 (res 64x64)`,
      `Receptors/_${t} Go Receptor 1x1`,
      `_${t} Go Receptor 1x1 (res 64x64)`,
    ));
    noteskin.receptorsPress[t] = await decodeUrl(lookupMap(
      `Receptors/_${t} Press Receptor 1x1 (res 64x64)`,
      `Receptors/_${t} Press Receptor 1x1`,
      `_${t} Press Receptor 1x1 (res 64x64)`,
    ));
  }

  const bodyUrl = lookupMap(
    'Holds/Up Hold Body Active (doubleres)',
    'Holds/Up Hold Body Active',
  );
  noteskin.holdBody = await decodeUrl(bodyUrl);

  const capUrl = lookupMap(
    'Holds/Up Hold BottomCap active (doubleres)',
    'Holds/Up Hold BottomCap Active (doubleres)',
    'Holds/Up Hold BottomCap active',
  );
  noteskin.holdCap  = await decodeUrl(capUrl);
  noteskin.holdTail = capUrl ? await (async () => {
    const r = await fetch(capUrl); return createImageBitmap(await r.blob());
  })() : null;

  const mineSrc = lookupMap('Misc/Mine 8x1', 'Mine 8x1');
  const mineBmp = await decodeUrl(mineSrc);
  noteskin.mine = mineBmp ? await extractFrame(mineBmp, 8, 1) : null;

  noteskin.lift = await decodeUrl(lookupMap('Misc/Lift', 'Lift'));

  // Judgement strip
  const stripSrc = lookupMap('default-judgement-strip');
  const strip = await decodeUrl(stripSrc);
  if (strip) {
    const sliceH = strip.height / 6;
    const keys = ['w1','w2','w3','w4','w5','miss'] as const;
    for (let i = 0; i < keys.length; i++) {
      try { noteskin.judgements[keys[i]] = await createImageBitmap(strip, 0, i * sliceH, strip.width, sliceH); }
      catch { /* skip */ }
    }
  }

  return noteskin;
}

// ─── Generic noteskin builder (CLI / Node path) ───────────────────────────────

function findSource<T>(sources: NamedSource<T>[], candidates: string[]): T | null {
  const norm = candidates.map(normalizeName);
  for (const s of sources) {
    const n = normalizeName(baseName(s.name));
    if (norm.includes(n)) return s.source;
  }
  return null;
}

function findJudgementStripSource<T>(sources: NamedSource<T>[]): T | null {
  for (const s of sources) {
    const n = s.name.toLowerCase();
    if (!n.match(/\.(png|webp|jpg|jpeg)$/)) continue;
    if (n.includes('1x6') && (n.includes('judg') || n.includes('gbp') || n.includes('normal'))) {
      return s.source;
    }
  }
  return null;
}

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
    { lower: 'right',upper: 'Right'as const },
  ];

  async function load(candidates: string[]): Promise<I | null> {
    const src = findSource(sources, candidates);
    return src != null ? loader(src) : null;
  }

  for (const dir of dirs) {
    noteskin.tapNotes[dir.upper] = await load([
      `_${dir.lower} tap note 1x1 (res 64x64).png`,
      `_${dir.lower} tap note 1x1.png`,
      `${dir.lower} tap note.png`,
      `tap_${dir.lower}.png`,
    ]);
    noteskin.receptorsGo[dir.upper] = await load([
      `_${dir.lower} go receptor 1x1 (res 64x64).png`,
      `_${dir.lower} go receptor 1x1.png`,
      `${dir.lower} go receptor.png`,
    ]);
    noteskin.receptorsPress[dir.upper] = await load([
      `_${dir.lower} press receptor 1x1 (res 64x64).png`,
      `_${dir.lower} press receptor 1x1.png`,
      `${dir.lower} press receptor.png`,
    ]);
  }

  noteskin.holdBody = await load([
    'up hold body active (doubleres).png',
    'hold body active (doubleres).png',
    'hold body.png',
  ]);
  const capSrc = findSource(sources, [
    'up hold bottomcap active (doubleres).png',
    'up hold bottomcap active.png',
    'hold bottomcap active (doubleres).png',
    'hold cap.png',
  ]);
  noteskin.holdCap  = capSrc != null ? await loader(capSrc) : null;
  noteskin.holdTail = capSrc != null ? await loader(capSrc) : null;
  noteskin.mine = await load(['mine 8x1.png', 'mine.png']);
  noteskin.lift = await load(['lift.png']);

  noteskin.judgements.w1   = await load(['w1.png', 'marvelous.png']);
  noteskin.judgements.w2   = await load(['w2.png', 'perfect.png']);
  noteskin.judgements.w3   = await load(['w3.png', 'great.png']);
  noteskin.judgements.w4   = await load(['w4.png', 'good.png']);
  noteskin.judgements.w5   = await load(['w5.png', 'boo.png']);
  noteskin.judgements.miss = await load(['miss.png', 'ng.png']);

  if (cropper) {
    const strip = await (async () => {
      const s = findJudgementStripSource(sources);
      return s ? loader(s) : null;
    })();
    if (strip) {
      const sw = (strip as unknown as { width: number }).width;
      const sh = (strip as unknown as { height: number }).height;
      const sliceH = sh / 6;
      const keys = ['w1','w2','w3','w4','w5','miss'] as const;
      for (let i = 0; i < keys.length; i++) {
        if (noteskin.judgements[keys[i]]) continue;
        noteskin.judgements[keys[i]] = await cropper(strip, 0, i * sliceH, sw, sliceH) as I | null;
      }
    }
  }

  return noteskin;
}

// ─── Transferables ────────────────────────────────────────────────────────────

export function collectBitmapTransferables(
  noteskin: NoteskinSet<ImageBitmap> | null,
  background: ImageBitmap | null,
): Transferable[] {
  const seen = new Set<ImageBitmap>();
  const out: Transferable[] = [];

  function add(b: ImageBitmap | null | undefined): void {
    if (b && !seen.has(b)) { seen.add(b); out.push(b); }
  }

  add(background);
  if (!noteskin) return out;
  for (const bucket of [noteskin.tapNotes, noteskin.receptorsGo, noteskin.receptorsPress, noteskin.judgements]) {
    for (const v of Object.values(bucket)) add(v as ImageBitmap | null);
  }
  add(noteskin.holdBody);
  add(noteskin.holdCap);
  add(noteskin.holdTail);
  add(noteskin.mine);
  add(noteskin.lift);
  return out;
}

export type { NoteskinSet };
