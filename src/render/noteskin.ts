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

function findSource<T>(sources: NamedSource<T>[], candidates: string[]): T | null {
  const normalized = candidates.map((candidate) => candidate.toLowerCase());
  for (const source of sources) {
    const name = source.name.toLowerCase();
    if (normalized.includes(name)) {
      return source.source;
    }
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

async function populateNoteskin<T, I>(
  name: string,
  sources: NamedSource<T>[],
  loader: (source: T) => Promise<I | null>,
  cropper?: NoteskinCropper<I>,
): Promise<NoteskinSet<I>> {
  const noteskin = createEmptyNoteskin<I>(name);
  const dirs = [
    { lower: 'left', upper: 'Left' as const },
    { lower: 'down', upper: 'Down' as const },
    { lower: 'up', upper: 'Up' as const },
    { lower: 'right', upper: 'Right' as const },
  ];

  for (const dir of dirs) {
    noteskin.tapNotes[dir.upper] = await maybeLoad(
      findSource(sources, [
        `_${dir.lower} tap note 1x1 (res 64x64).png`,
        `${dir.lower} tap note.png`,
        `tap_${dir.lower}.png`,
        `note_${dir.lower}.png`,
        `${dir.lower}.png`,
        `arrow_${dir.lower}.png`,
      ]),
      loader,
    );
    noteskin.receptorsGo[dir.upper] = await maybeLoad(
      findSource(sources, [
        `_${dir.lower} go receptor 1x1 (res 64x64).png`,
        `${dir.lower} go receptor.png`,
        `receptor_${dir.lower}.png`,
        `receptor_${dir.lower}_go.png`,
      ]),
      loader,
    );
    noteskin.receptorsPress[dir.upper] = await maybeLoad(
      findSource(sources, [
        `_${dir.lower} press receptor 1x1 (res 64x64).png`,
        `${dir.lower} press receptor.png`,
        `receptor_${dir.lower}_press.png`,
      ]),
      loader,
    );
  }

  noteskin.holdBody = await maybeLoad(
    findSource(sources, [
      'up hold body active (doubleres).png',
      'hold body.png',
      'hold_body.png',
      'longnote_body.png',
    ]),
    loader,
  );
  noteskin.holdCap = await maybeLoad(
    findSource(sources, [
      'up hold bottomcap active (doubleres).png',
      'up hold topcap active (doubleres).png',
      'hold cap.png',
      'hold_cap.png',
    ]),
    loader,
  );
  noteskin.holdTail = await maybeLoad(
    findSource(sources, [
      'up hold topcap active (doubleres).png',
      'up hold bottomcap active (doubleres).png',
      'hold tail.png',
      'hold_tail.png',
      'hold end.png',
      'hold_end.png',
      'longnote_tail.png',
      'longnote_end.png',
    ]),
    loader,
  );
  noteskin.mine = await maybeLoad(
    findSource(sources, ['mine 8x1.png', 'mine.png', 'mine_8x1.png']),
    loader,
  );
  noteskin.lift = await maybeLoad(findSource(sources, ['lift.png']), loader);

  noteskin.judgements.w1 = await maybeLoad(
    findSource(sources, ['w1.png', 'marvelous.png', 'fantastic.png', 'judgment_perfect.png']),
    loader,
  );
  noteskin.judgements.w2 = await maybeLoad(
    findSource(sources, ['w2.png', 'perfect.png', 'judgment_great.png']),
    loader,
  );
  noteskin.judgements.w3 = await maybeLoad(
    findSource(sources, ['w3.png', 'great.png', 'judgment_good.png']),
    loader,
  );
  noteskin.judgements.w4 = await maybeLoad(
    findSource(sources, ['w4.png', 'good.png', 'judgment_ok.png']),
    loader,
  );
  noteskin.judgements.w5 = await maybeLoad(
    findSource(sources, ['w5.png', 'boo.png', 'judgment_meh.png']),
    loader,
  );
  noteskin.judgements.miss = await maybeLoad(
    findSource(sources, ['miss.png', 'judgment_miss.png', 'ng.png']),
    loader,
  );

  const missingJudgements = (Object.entries(noteskin.judgements) as Array<[keyof NoteskinSet<I>['judgements'], I | null | undefined]>)
    .filter(([, image]) => !image)
    .map(([key]) => key);

  if (cropper && missingJudgements.length > 0) {
    const stripSource = findJudgementStripSource(sources);
    const stripImage = await maybeLoad(stripSource, loader);
    if (stripImage) {
      const stripWidth = Number((stripImage as { width?: number }).width ?? 0);
      const stripHeight = Number((stripImage as { height?: number }).height ?? 0);
      const sliceHeight = stripHeight >= 6 ? stripHeight / 6 : 0;
      if (stripWidth > 0 && sliceHeight > 0) {
        const keys: Array<keyof NoteskinSet<I>['judgements']> = ['w1', 'w2', 'w3', 'w4', 'w5', 'miss'];
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index];
          if (noteskin.judgements[key]) continue;
          noteskin.judgements[key] = await cropper(stripImage, 0, index * sliceHeight, stripWidth, sliceHeight);
        }
      }
    }
  }

  return noteskin;
}

export async function buildNoteskinFromSources<T, I>(
  name: string,
  sources: NamedSource<T>[],
  loader: (source: T) => Promise<I | null>,
  cropper?: NoteskinCropper<I>,
): Promise<NoteskinSet<I>> {
  return populateNoteskin(name, sources, loader, cropper);
}

async function createBitmapFromDataUrl(src: string): Promise<ImageBitmap | null> {
  try {
    const response = await fetch(src);
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

async function createBitmapFromFile(file: File): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

async function cropBitmap(image: ImageBitmap, sx: number, sy: number, sw: number, sh: number): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(image, sx, sy, sw, sh);
  } catch {
    return null;
  }
}

export async function buildDefaultNoteskinBitmaps(): Promise<NoteskinSet<ImageBitmap>> {
  const sources = [
    ...Object.entries(NOTESKIN_ASSETS).map(([name, source]) => ({ name, source })),
    { name: 'default-judgement-strip.png', source: '/judgements/default-judgement-strip.png' },
  ];
  return populateNoteskin('AmbieZeroTwo', sources, createBitmapFromDataUrl, cropBitmap);
}

export async function buildCustomNoteskinBitmaps(files: File[], extraFiles: File[] = []): Promise<NoteskinSet<ImageBitmap>> {
  const combinedFiles = [...files, ...extraFiles];
  const named = combinedFiles.map((file) => ({ name: file.name, source: file }));
  const name = files[0]?.webkitRelativePath?.split('/')[0] || 'custom';
  return populateNoteskin(name, named, createBitmapFromFile, cropBitmap);
}

export function collectBitmapTransferables(noteskin: NoteskinSet<ImageBitmap> | null, background: ImageBitmap | null): Transferable[] {
  const transferables: Transferable[] = [];
  if (background) {
    transferables.push(background);
  }
  if (!noteskin) {
    return transferables;
  }
  const buckets = [noteskin.tapNotes, noteskin.receptorsGo, noteskin.receptorsPress, noteskin.judgements];
  for (const bucket of buckets) {
    for (const image of Object.values(bucket)) {
      if (image) transferables.push(image);
    }
  }
  if (noteskin.holdBody) transferables.push(noteskin.holdBody);
  if (noteskin.holdCap) transferables.push(noteskin.holdCap);
  if (noteskin.holdTail) transferables.push(noteskin.holdTail);
  if (noteskin.mine) transferables.push(noteskin.mine);
  if (noteskin.lift) transferables.push(noteskin.lift);
  return transferables;
}

export type { NoteskinSet };
