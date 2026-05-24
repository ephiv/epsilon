// ═══════════════════════════════════════════════════
// epsilon — parsers.js
// ═══════════════════════════════════════════════════

// ──────────────────────────────────────────
// .osu parser
// ──────────────────────────────────────────
function parseOsuFile(text) {
  const lines = text.split(/\r?\n/);
  const map = {
    title:'', artist:'', audioFilename:'', bgFilename:'',
    keyCount:4, overallDifficulty:5, hpDrainRate:5,
    timingPoints:[], hitObjects:[], bpms:[], svPoints:[],
  };
  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    if (line.startsWith('[')) { section = line.slice(1,-1); continue; }

    const val = () => line.split(':').slice(1).join(':').trim();

    if (section === 'General') {
      if (line.startsWith('AudioFilename:')) map.audioFilename = val();
    }
    if (section === 'Metadata') {
      if (line.startsWith('Title:'))  map.title  = val();
      if (line.startsWith('Artist:')) map.artist = val();
      if (line.startsWith('Version:')) map.version = val();
    }
    if (section === 'Events') {
      const p = line.split(',');
      if ((p[0]==='0'||p[0]==='Background') && p[2])
        map.bgFilename = p[2].replace(/"/g,'').trim();
    }
    if (section === 'Difficulty') {
      if (line.startsWith('CircleSize:'))       map.keyCount = parseInt(val())||4;
      if (line.startsWith('OverallDifficulty:'))map.overallDifficulty = parseFloat(val());
      if (line.startsWith('HPDrainRate:'))      map.hpDrainRate = parseFloat(val());
    }
    if (section === 'TimingPoints') {
      const p = line.split(',');
      if (p.length < 2) continue;
      const time     = parseFloat(p[0]);
      const beatLen  = parseFloat(p[1]);
      const uninherited = p[6] !== undefined ? parseInt(p[6]) : 1;
      const tp = { time, beatLength: beatLen, uninherited: uninherited === 1 };
      map.timingPoints.push(tp);
      if (uninherited === 1 && beatLen > 0) {
        map.bpms.push({ time, bpm: 60000 / beatLen });
      } else if (uninherited === 0 && beatLen < 0) {
        // SV: negative beatLength is -100/svMultiplier
        map.svPoints.push({ time, sv: -100 / beatLen });
      }
    }
    if (section === 'HitObjects') {
      const p = line.split(',');
      if (p.length < 5) continue;
      const x = parseInt(p[0]);
      const startTime = parseInt(p[2]);
      const type = parseInt(p[3]);
      const isLN = (type & 128) !== 0;
      const col = Math.max(0, Math.min(map.keyCount-1, Math.floor(x * map.keyCount / 512)));
      const obj = { x, col, startTime, type, isLN };
      if (isLN) {
        const extras = p[5] ? p[5].split(':') : [];
        obj.endTime = parseInt(extras[0]) || startTime;
      }
      map.hitObjects.push(obj);
    }
  }
  map.hitObjects.sort((a,b)=>a.startTime-b.startTime);

  // Compute SV multiplier at each hit object (affects scroll speed)
  // Base: product of SV at that time point
  map.hitObjects.forEach(obj => {
    obj.sv = getSVAt(map, obj.startTime);
  });

  return map;
}

function getSVAt(map, time) {
  let sv = 1.0;
  for (const p of map.svPoints) {
    if (p.time <= time) sv = p.sv;
    else break;
  }
  return sv;
}

// Build a cumulative scroll position map for accurate note positions
// In osu!mania, the scroll position of a note at time T is:
//   pos(T) = integral of SV(t) dt from 0 to T  (in units of ms*sv)
// We precompute this so noteY is pixel-accurate with SV changes.
function buildScrollPositions(map) {
  // Merge timing and sv events sorted by time
  const events = [...map.bpms.map(b=>({t:b.time,type:'bpm',v:b.bpm})),
                  ...map.svPoints.map(s=>({t:s.time,type:'sv',v:s.sv}))];
  events.sort((a,b)=>a.t-b.t);

  // For each hit object, compute accumulated scroll beats
  // scrollPos = sum over segments of: SV * (segLen/beatLen) * 1
  // osu!mania: position = integral BPM/60000 * SV * dt (in beats)
  // Simplified: we track cumulative "scroll units" = sum(SV * dt_ms)
  // Then position = scrollUnits * scrollSpeed gives pixels from hit line

  let curBPM = (map.bpms[0]?.bpm) || 120;
  let curSV = 1.0;
  let lastT = map.bpms[0]?.time || 0;
  let accumPos = 0; // at lastT

  // We'll store per-ms accumulated scroll position as a function
  // Build breakpoints
  const bps = [{t: lastT, pos: 0, sv: curSV, bpm: curBPM}];

  for (const ev of events) {
    const dt = ev.t - lastT;
    if (dt > 0) accumPos += dt * curSV;
    lastT = ev.t;
    if (ev.type === 'bpm') curBPM = ev.v;
    else curSV = ev.v;
    bps.push({t: ev.t, pos: accumPos, sv: curSV, bpm: curBPM});
  }

  // Function: given time T, return accumulated scroll position
  function scrollPosAt(T) {
    if (T <= bps[0].t) return bps[0].pos + (T - bps[0].t) * bps[0].sv;
    for (let i = bps.length-1; i >= 0; i--) {
      if (T >= bps[i].t) {
        return bps[i].pos + (T - bps[i].t) * bps[i].sv;
      }
    }
    return 0;
  }

  return scrollPosAt;
}

// ──────────────────────────────────────────
// .osr binary parser
// ──────────────────────────────────────────
function parseOsrFile(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let pos = 0;

  function readByte()  { return view.getUint8(pos++); }
  function readUInt16(){ const v=view.getUint16(pos,true); pos+=2; return v; }
  function readInt32() { const v=view.getInt32(pos,true); pos+=4; return v; }
  function readUInt32(){ const v=view.getUint32(pos,true); pos+=4; return v; }
  function readInt64() {
    const lo=view.getUint32(pos,true), hi=view.getUint32(pos+4,true);
    pos+=8; return lo+hi*4294967296;
  }
  function readULEB128() {
    let r=0,s=0;
    while(true){ const b=readByte(); r|=(b&0x7F)<<s; if(!(b&0x80))break; s+=7; }
    return r;
  }
  function readString() {
    const exists=readByte();
    if (exists===0x0b) {
      const len=readULEB128();
      const dec=new TextDecoder('utf-8').decode(bytes.subarray(pos,pos+len));
      pos+=len; return dec;
    }
    return '';
  }

  const replay = {};
  try {
    replay.gameMode        = readByte();
    replay.gameVersion     = readInt32();
    replay.beatmapMD5      = readString();
    replay.playerName      = readString();
    replay.replayMD5       = readString();
    replay.count300        = readUInt16();
    replay.count100        = readUInt16();
    replay.count50         = readUInt16();
    replay.countGeki       = readUInt16(); // MAX/rainbow 300
    replay.countKatu       = readUInt16(); // 200
    replay.countMiss       = readUInt16();
    replay.totalScore      = readUInt32();
    replay.maxCombo        = readUInt16();
    replay.perfectCombo    = readByte();
    replay.mods            = readUInt32();
    replay.lifeGraph       = readString();
    replay.timestamp       = readInt64();
    const compressedLen    = readInt32();
    replay.compressedLen   = compressedLen;
    replay.compressedOffset= pos;
    // Try reading replay ID (after compressed data)
    replay.rawOk           = compressedLen >= 0;

    // Compute mod names
    const MOD_NAMES = {1:'NF',2:'EZ',4:'TD',8:'HD',16:'HR',32:'SD',64:'DT',128:'RX',
      256:'HT',512:'NC',1024:'FL',2048:'AT',4096:'SO',8192:'AP',16384:'PF',32768:'K4',
      65536:'K5',131072:'K6',262144:'K7',524288:'K8',1048576:'FI',2097152:'RN',
      4194304:'CN',8388608:'TG',16777216:'K9',33554432:'KC',67108864:'K1',
      134217728:'K2',268435456:'K3',536870912:'SV2',1073741824:'MR'};
    replay.modNames = [];
    for (const [bit, name] of Object.entries(MOD_NAMES)) {
      if (replay.mods & parseInt(bit)) replay.modNames.push(name);
    }
    replay.isDoubleTime = !!(replay.mods & (64|512));
    replay.isHalfTime   = !!(replay.mods & 256);
    replay.clockRate    = replay.isDoubleTime ? 1.5 : replay.isHalfTime ? 0.75 : 1.0;
  } catch(e) {
    console.warn('OSR header parse error:', e);
  }
  return replay;
}

// ──────────────────────────────────────────
// LZMA decompression + replay event parsing
// ──────────────────────────────────────────
// osu!mania replay key mapping:
//   The 'x' field in replay frames is a bitmask of pressed columns.
//   Bit 0 (value 1)  = column 1
//   Bit 1 (value 2)  = column 2
//   Bit 2 (value 4)  = column 3
//   etc.
// The 'y' field is unused in mania (always 192 or similar)
// w = time delta in ms
// x = keys bitmask
// y = (unused)
// z = (unused, smoke key)

async function decompressReplayData(buffer, offset, length) {
  if (!length || length <= 0) return [];
  const compressed = new Uint8Array(buffer, offset, length);

  // Try native LZMA via DecompressionStream (Chrome 102+ supports 'deflate-raw' but not lzma)
  // Try LZMA-JS if loaded
  if (typeof LZMA !== 'undefined') {
    return new Promise(resolve => {
      try {
        LZMA.decompress(Array.from(compressed), (result, err) => {
          if (err || !result) { resolve([]); return; }
          const text = typeof result === 'string' ? result :
            new TextDecoder('ascii').decode(new Uint8Array(result));
          resolve(parseReplayText(text));
        });
      } catch(e) { resolve([]); }
    });
  }

  // Fallback: try loading LZMA-JS dynamically
  return new Promise(resolve => {
    try {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/lzma-js/1.3.4/lzma_worker-min.js';
      script.onload = () => {
        if (typeof LZMA !== 'undefined') {
          LZMA.decompress(Array.from(compressed), (result, err) => {
            if (err || !result) { resolve([]); return; }
            const text = typeof result === 'string' ? result :
              new TextDecoder('ascii').decode(new Uint8Array(result));
            resolve(parseReplayText(text));
          });
        } else resolve([]);
      };
      script.onerror = () => resolve([]);
      document.head.appendChild(script);
    } catch(e) { resolve([]); }
  });
}

function parseReplayText(text) {
  const frames = [];
  let absoluteTime = 0;
  for (const token of text.split(',')) {
    const t = token.trim();
    if (!t) continue;
    const parts = t.split('|');
    if (parts.length < 4) continue;
    const w = parseInt(parts[0]);
    const x = parseFloat(parts[1]);
    const y = parseFloat(parts[2]);
    const z = parseInt(parts[3]);
    if (w === -12345) continue; // RNG seed frame, skip
    absoluteTime += w;
    frames.push({ time: absoluteTime, keys: x, y, z });
  }
  return frames;
}

// Extract column press/release events from raw replay frames
// osu!mania: x field = bitmask, bit N-1 set = column N held
function extractManiaPresses(frames, keyCount) {
  const presses = Array.from({length: keyCount}, () => []);
  let prevMask = 0;
  for (const frame of frames) {
    const mask = Math.round(frame.keys); // x field is the key bitmask
    for (let col = 0; col < keyCount; col++) {
      const bit = 1 << col;
      const wasDown = (prevMask & bit) !== 0;
      const isDown  = (mask & bit) !== 0;
      if (!wasDown && isDown)  presses[col].push({time: frame.time, type:'press'});
      if (wasDown  && !isDown) presses[col].push({time: frame.time, type:'release'});
    }
    prevMask = mask;
  }
  return presses;
}

// Build a fast lookup: for time T, is column C held?
function buildPressMaps(presses) {
  // Returns flat sorted event list per column with index for O(log n) seek
  return presses; // already indexed by column
}

// ──────────────────────────────────────────
// Etterna noteskin parser
// ──────────────────────────────────────────
// Given a FileList from a folder picker, group and encode assets
async function parseEtternaNoteskin(files) {
  const ns = {
    name: 'custom',
    tapNotes: {},
    receptorsGo: {},
    receptorsPress: {},
    holdBody: null, holdCap: null,
    mine: null, lift: null,
    judgements: {},
  };

  const fileMap = {};
  for (const f of files) {
    const name = f.name;
    const nameL = name.toLowerCase();
    fileMap[nameL] = f;
    // Also store by stem
    const stem = nameL.replace(/\.(png|jpg|jpeg|gif|bmp)$/, '');
    fileMap[stem] = f;
  }

  const toB64 = async (file) => {
    if (!file) return null;
    return new Promise(res => {
      const r = new FileReader();
      r.onload = e => {
        const img = new Image();
        img.onload = () => res(img);
        img.src = e.target.result;
      };
      r.readAsDataURL(file);
    });
  };

  // Try to find files by common Etterna naming patterns
  const dirs = ['left','down','up','right'];
  const dirCap = ['Left','Down','Up','Right'];

  for (let i = 0; i < 4; i++) {
    const d = dirs[i], D = dirCap[i];
    // Tap notes: various common naming conventions
    const tapCandidates = [
      `_${d} tap note 1x1 (res 64x64).png`,
      `${d} tap note.png`, `tap_${d}.png`, `note_${d}.png`,
      `${d}.png`, `arrow_${d}.png`,
    ];
    for (const c of tapCandidates) {
      if (fileMap[c]) { ns.tapNotes[D] = await toB64(fileMap[c]); break; }
    }

    const rGoCandidates = [
      `_${d} go receptor 1x1 (res 64x64).png`,
      `${d} go receptor.png`, `receptor_${d}.png`, `receptor_${d}_go.png`,
    ];
    for (const c of rGoCandidates) {
      if (fileMap[c]) { ns.receptorsGo[D] = await toB64(fileMap[c]); break; }
    }

    const rPressCandidates = [
      `_${d} press receptor 1x1 (res 64x64).png`,
      `${d} press receptor.png`, `receptor_${d}_press.png`,
    ];
    for (const c of rPressCandidates) {
      if (fileMap[c]) { ns.receptorsPress[D] = await toB64(fileMap[c]); break; }
    }
  }

  // Hold body/cap
  const holdCandidates = ['up hold body active (doubleres).png','hold body.png','hold_body.png','longnote_body.png'];
  const capCandidates  = ['up hold bottomcap active (doubleres).png','hold cap.png','hold_cap.png'];
  for (const c of holdCandidates) if (fileMap[c]) { ns.holdBody = await toB64(fileMap[c]); break; }
  for (const c of capCandidates)  if (fileMap[c]) { ns.holdCap  = await toB64(fileMap[c]); break; }

  // Mine
  const mineCandidates = ['mine 8x1.png','mine.png','mine_8x1.png'];
  for (const c of mineCandidates) if (fileMap[c]) { ns.mine = await toB64(fileMap[c]); break; }

  // Judgement images — common Etterna names
  const judgeNames = {
    'w1': ['w1.png','marvelous.png','fantastic.png','judgment_perfect.png'],
    'w2': ['w2.png','perfect.png','judgment_great.png'],
    'w3': ['w3.png','great.png','judgment_good.png'],
    'w4': ['w4.png','good.png','judgment_ok.png'],
    'w5': ['w5.png','boo.png','judgment_miss.png'],
    'miss': ['miss.png','judgment_miss.png','ng.png'],
  };
  for (const [grade, candidates] of Object.entries(judgeNames)) {
    for (const c of candidates) {
      if (fileMap[c]) { ns.judgements[grade] = await toB64(fileMap[c]); break; }
    }
  }

  // Extract name from folder path if available
  if (files[0]?.webkitRelativePath) {
    ns.name = files[0].webkitRelativePath.split('/')[0];
  }

  return ns;
}

// Build noteskin from the embedded NOTESKIN_ASSETS (AmbieZeroTwo)
async function buildDefaultNoteskin(assets) {
  const ns = { name: 'AmbieZeroTwo', tapNotes:{}, receptorsGo:{}, receptorsPress:{},
               holdBody:null, holdCap:null, mine:null, lift:null, judgements:{} };

  const load = key => new Promise(res => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = assets[key] || '';
  });

  for (const dir of ['Left','Down','Up','Right']) {
    ns.tapNotes[dir]      = await load(`Notes/_${dir}_Tap_Note_1x1_res_64x64.png`);
    ns.receptorsGo[dir]   = await load(`Receptors/_${dir}_Go_Receptor_1x1_res_64x64.png`);
    ns.receptorsPress[dir]= await load(`Receptors/_${dir}_Press_Receptor_1x1_res_64x64.png`);
  }
  ns.holdBody = await load('Holds/Up_Hold_Body_Active_doubleres.png');
  ns.holdCap  = await load('Holds/Up_Hold_BottomCap_active_doubleres.png');
  ns.mine     = await load('Misc/Mine_8x1.png');
  ns.lift     = await load('Misc/Lift.png');

  // No judgement images in AmbieZeroTwo, use text fallback
  return ns;
}
