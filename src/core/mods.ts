export const MOD_BITS = {
  NF: 1,
  EZ: 2,
  TD: 4,
  HD: 8,
  HR: 16,
  SD: 32,
  DT: 64,
  RX: 128,
  HT: 256,
  NC: 512,
  FL: 1024,
  AT: 2048,
  SO: 4096,
  AP: 8192,
  PF: 16384,
  K4: 32768,
  K5: 65536,
  K6: 131072,
  K7: 262144,
  K8: 524288,
  FI: 1048576,
  RN: 2097152,
  CN: 4194304,
  TG: 8388608,
  K9: 16777216,
  KC: 33554432,
  K1: 67108864,
  K3: 134217728,
  K2: 268435456,
  SV2: 536870912,
  MR: 1073741824,
} as const;

export const MOD_NAMES = Object.entries(MOD_BITS).reduce<Record<number, string>>((acc, [name, bit]) => {
  acc[bit] = name;
  return acc;
}, {});

export function getModNames(bits: number): string[] {
  return Object.entries(MOD_NAMES)
    .filter(([bit]) => (bits & Number(bit)) !== 0)
    .map(([, name]) => name);
}

export function getClockRate(bits: number): number {
  if (bits & (MOD_BITS.DT | MOD_BITS.NC)) {
    return 1.5;
  }
  if (bits & MOD_BITS.HT) {
    return 0.75;
  }
  return 1;
}

export function isMirror(bits: number): boolean {
  return (bits & MOD_BITS.MR) !== 0;
}

export function isScoreV2(bits: number): boolean {
  return (bits & MOD_BITS.SV2) !== 0;
}

export function scoreV1ModMultiplier(bits: number): number {
  let multiplier = 1;
  if (bits & MOD_BITS.NF) multiplier *= 0.5;
  if (bits & MOD_BITS.EZ) multiplier *= 0.5;
  if (bits & MOD_BITS.HT) multiplier *= 0.5;
  return multiplier;
}

export function scoreV1BonusDivider(bits: number): number {
  let divider = 1;
  if (bits & MOD_BITS.HR) divider *= 1.08;
  if (bits & (MOD_BITS.DT | MOD_BITS.NC)) divider *= 1.1;
  if (bits & MOD_BITS.FI) divider *= 1.06;
  if (bits & MOD_BITS.HD) divider *= 1.06;
  if (bits & MOD_BITS.FL) divider *= 1.06;
  return divider;
}
