export type ColumnDirection = 'Left' | 'Down' | 'Up' | 'Right';

export interface NoteskinSet<T = unknown> {
  name: string;
  tapNotes: Partial<Record<ColumnDirection, T | null>>;
  receptorsGo: Partial<Record<ColumnDirection, T | null>>;
  receptorsPress: Partial<Record<ColumnDirection, T | null>>;
  holdBody: T | null;
  holdCap: T | null;
  holdTail: T | null;
  mine: T | null;
  lift: T | null;
  judgements: Partial<Record<'w1' | 'w2' | 'w3' | 'w4' | 'w5' | 'miss', T | null>>;
}
