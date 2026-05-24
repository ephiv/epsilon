// ═══════════════════════════════════════════════════
// epsilon — renderer.js
// ═══════════════════════════════════════════════════

class EpsilonRenderer {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.settings = {
      // Scroll: osu! fixed-scale units. Formula:
      //   visibleMs = 13720 / scrollSpeed
      //   px per ms = canvasHeight * hitPosition / visibleMs
      scrollSpeed:       20,
      hitPosition:       0.88,   // 0-1 from top
      laneWidth:         70,
      laneGap:           2,
      laneBorderWidth:   1,
      laneBorderColor:   'rgba(255,255,255,0.12)',
      laneColor:         'rgba(255,255,255,0.03)',
      judgeLineOpacity:  0.6,
      playFieldOpacity:  1.0,
      dimBg:             0.5,
      motionBlur:        true,
      motionBlurSamples: 5,
      motionBlurStrength:0.35,
      showKeypress:      true,
      noteShadows:       true,
      customFont:        null,    // loaded FontFace name or null
      hitWindowPerfect:  16,
      hitWindowGreat:    40,
      hitWindowGood:     73,
      hitWindowOk:       103,
      hitWindowMeh:      127,
      // HUD element positions: each is {anchor, offsetX, offsetY}
      // anchor: 'tl','tc','tr','ml','mc','mr','bl','bc','br'
      hudScore:   { anchor:'tr', offsetX:-10, offsetY:40 },
      hudCombo:   { anchor:'bc', offsetX:0,   offsetY:-120 },
      hudAcc:     { anchor:'tl', offsetX:10,  offsetY:40 },
      hudJudge:   { anchor:'bc', offsetX:0,   offsetY:-80 },
      ...settings,
    };
    this.map = null;
    this.noteskin = null;
    this.bgImage = null;
    this.scrollPos = null; // function: time -> scroll units
    this._noteHit = [];
    this.colStates = [];
    this.judgements = [];
    this.scoreState = { score:0, combo:0, maxCombo:0, counts:{320:0,300:0,200:0,100:0,50:0,miss:0} };
    this._pressIdx = [];
    this.keyPresses = null;
  }

  // ── scroll speed: osu units → px/ms ──────────────────
  // osu! fixed scale: at scrollSpeed N, notes take 13720/N ms to cross full playfield
  // Our "visible time" = time from top to hit line = 13720/scrollSpeed ms
  // px per ms = (canvas.height * hitPosition) / visibleMs
  pxPerMs() {
    const visibleMs = 13720 / this.settings.scrollSpeed;
    return (this.canvas.height * this.settings.hitPosition) / visibleMs;
  }

  // Note Y given song time and note time, with SV support
  noteY(noteTime, currentTime) {
    const hitY = this.canvas.height * this.settings.hitPosition;
    const rate = this.pxPerMs();

    if (this.scrollPos) {
      // SV-aware: difference in scroll units * rate
      const noteSP    = this.scrollPos(noteTime);
      const currentSP = this.scrollPos(currentTime);
      return hitY - (noteSP - currentSP) * rate;
    }
    return hitY - (noteTime - currentTime) * rate;
  }

  colX(col) {
    const k = this.map?.keyCount || 4;
    const totalW = k * this.settings.laneWidth + (k-1) * this.settings.laneGap;
    const startX = (this.canvas.width - totalW) / 2;
    return startX + col * (this.settings.laneWidth + this.settings.laneGap);
  }

  getDir(col, k) {
    const map4 = ['Left','Down','Up','Right'];
    const map7 = ['Left','Down','Left','Up','Right','Up','Right'];
    if (k <= 4)  return map4[col % 4];
    if (k <= 7)  return map7[col % 7];
    return map4[col % 4];
  }

  loadMap(map) {
    this.map = map;
    this.scrollPos = buildScrollPositions(map);
    this.colStates = Array.from({length: map.keyCount}, () => ({pressed:false}));
    this._noteHit  = new Array(map.hitObjects.length).fill(false);
    this._pressIdx = Array.from({length: map.keyCount}, () => 0);
    this.judgements = [];
    this.scoreState = { score:0, combo:0, maxCombo:0, counts:{320:0,300:0,200:0,100:0,50:0,miss:0} };
  }

  loadNoteskin(ns) { this.noteskin = ns; }
  loadBg(img)      { this.bgImage = img; }
  loadReplay(kp)   { this.keyPresses = kp; this._pressIdx = kp ? Array.from({length:kp.length},()=>0) : []; }

  reset() {
    if (!this.map) return;
    this.colStates = Array.from({length:this.map.keyCount},()=>({pressed:false}));
    this._noteHit  = new Array(this.map.hitObjects.length).fill(false);
    this._pressIdx = Array.from({length:this.map.keyCount},()=>0);
    this.judgements = [];
    this.scoreState = { score:0, combo:0, maxCombo:0, counts:{320:0,300:0,200:0,100:0,50:0,miss:0} };
  }

  getBpmAt(time) {
    let bpm = 120;
    for (const b of (this.map?.bpms||[])) {
      if (b.time <= time) bpm = b.bpm; else break;
    }
    return bpm;
  }

  // ── UPDATE replay state ──────────────────────────────
  updateFromReplay(time) {
    if (!this.keyPresses || !this.map) return;
    const k = this.map.keyCount;
    for (let col = 0; col < k; col++) {
      const presses = this.keyPresses[col] || [];
      while (this._pressIdx[col] < presses.length && presses[this._pressIdx[col]].time <= time) {
        const ev = presses[this._pressIdx[col]];
        this.colStates[col].pressed = ev.type === 'press';
        this._pressIdx[col]++;
      }
    }
  }

  // ── JUDGE ────────────────────────────────────────────
  judgeNote(noteTime, hitTime, col) {
    const diff = Math.abs(hitTime - noteTime);
    const s = this.settings;
    let grade;
    if      (diff <= s.hitWindowPerfect) grade = 320;
    else if (diff <= s.hitWindowGreat)   grade = 300;
    else if (diff <= s.hitWindowGood)    grade = 200;
    else if (diff <= s.hitWindowOk)      grade = 100;
    else if (diff <= s.hitWindowMeh)     grade = 50;
    else                                 grade = 'miss';

    const sc = this.scoreState;
    sc.counts[grade] = (sc.counts[grade]||0) + 1;
    if (grade === 'miss') { sc.combo = 0; }
    else {
      sc.combo++;
      sc.maxCombo = Math.max(sc.maxCombo, sc.combo);
      const comboBonus = 1 + Math.floor(sc.combo / 50) * 0.1;
      sc.score += grade * comboBonus;
    }
    this.judgements.push({ time: hitTime, col, grade });
  }

  // ── RENDER ───────────────────────────────────────────
  render(time) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const k = this.map?.keyCount || 4;

    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.globalAlpha = this.settings.playFieldOpacity;

    this._drawBg(ctx, W, H);
    this._drawLanes(ctx, W, H, k);
    this._drawJudgeLine(ctx, W, H, k);
    this._drawNotes(ctx, W, H, k, time);
    this._drawReceptors(ctx, W, H, k);

    ctx.restore();

    this._drawJudgeEffects(ctx, W, H, time);
    this._drawHUD(ctx, W, H, time);
  }

  _drawBg(ctx, W, H) {
    if (this.bgImage) {
      const s = Math.max(W/this.bgImage.width, H/this.bgImage.height);
      const sw = this.bgImage.width*s, sh = this.bgImage.height*s;
      ctx.drawImage(this.bgImage, (W-sw)/2, (H-sh)/2, sw, sh);
    } else {
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0,0,W,H);
    }
    ctx.fillStyle = `rgba(0,0,0,${this.settings.dimBg})`;
    ctx.fillRect(0,0,W,H);
  }

  _drawLanes(ctx, W, H, k) {
    const lw = this.settings.laneWidth;
    const hitY = H * this.settings.hitPosition;
    const totalW = k*lw + (k-1)*this.settings.laneGap;
    const startX = (W-totalW)/2;

    // Stage side borders
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(startX-2, 0, 2, H);
    ctx.fillRect(startX+totalW, 0, 2, H);

    for (let col = 0; col < k; col++) {
      const x = this.colX(col);
      // Lane bg
      ctx.fillStyle = this.settings.laneColor;
      ctx.fillRect(x, 0, lw, H);
      // Lane border
      if (this.settings.laneBorderWidth > 0) {
        ctx.fillStyle = this.settings.laneBorderColor;
        ctx.fillRect(x-this.settings.laneBorderWidth, 0, this.settings.laneBorderWidth, H);
      }
      // Key highlight when pressed
      if (this.settings.showKeypress && this.colStates[col]?.pressed) {
        const grad = ctx.createLinearGradient(x, 0, x, hitY);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(1, 'rgba(255,255,255,0.08)');
        ctx.fillStyle = grad;
        ctx.fillRect(x, 0, lw, hitY);
      }
    }
  }

  _drawJudgeLine(ctx, W, H, k) {
    const hitY = H * this.settings.hitPosition;
    const totalW = k*this.settings.laneWidth + (k-1)*this.settings.laneGap;
    const startX = (W-totalW)/2;
    ctx.save();
    ctx.globalAlpha = this.settings.judgeLineOpacity;
    ctx.shadowColor = '#fff';
    ctx.shadowBlur  = 6;
    ctx.fillStyle   = 'rgba(255,255,255,0.6)';
    ctx.fillRect(startX, hitY, totalW, 2);
    ctx.restore();
  }

  _drawNotes(ctx, W, H, k, time) {
    const hitY  = H * this.settings.hitPosition;
    const lw    = this.settings.laneWidth;
    const rate  = this.pxPerMs();
    const objs  = this.map?.hitObjects || [];
    const ns    = this.noteskin;

    // Visible window: notes visible on screen
    // Top of screen is ahead by hitY/rate ms, below hitLine we show a bit past
    const aheadMs  = hitY / rate + 200;
    const behindMs = (H - hitY) / rate + 200;
    const visStart = time - behindMs;
    const visEnd   = time + aheadMs;

    // Draw holds first (under tap notes)
    for (let i = 0; i < objs.length; i++) {
      const obj = objs[i];
      if (obj.startTime > visEnd) break;
      if (!obj.isLN) continue;
      if (obj.endTime < visStart) continue;
      if (this._noteHit[i] && obj.endTime < time) continue;

      this._drawHoldNote(ctx, obj, time, lw, k, ns);
    }

    // Draw tap notes on top
    for (let i = 0; i < objs.length; i++) {
      const obj = objs[i];
      if (obj.startTime > visEnd) break;
      if (obj.startTime < visStart && !obj.isLN) continue;
      if (this._noteHit[i]) continue;
      if (obj.isLN) continue;

      const y   = this.noteY(obj.startTime, time);
      const x   = this.colX(obj.col);
      const dir = this.getDir(obj.col, k);
      this._drawTapNote(ctx, x, y, lw, dir, ns);
    }
  }

  _drawTapNote(ctx, x, y, lw, dir, ns) {
    const img = ns?.tapNotes?.[dir];
    if (img && img.complete && img.naturalWidth > 0) {
      if (this.settings.noteShadows) {
        ctx.shadowColor = this._noteColor(dir);
        ctx.shadowBlur  = 10;
      }
      ctx.drawImage(img, x, y - lw/2, lw, lw);
      ctx.shadowBlur = 0;
    } else {
      // Fallback: colored rectangle
      const col = this._noteColor(dir);
      ctx.fillStyle = col;
      if (this.settings.noteShadows) { ctx.shadowColor = col; ctx.shadowBlur = 8; }
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x+2, y-lw/2+2, lw-4, lw-4, 5);
      else ctx.rect(x+2, y-lw/2+2, lw-4, lw-4);
      ctx.fill();
      ctx.shadowBlur = 0;
      // White highlight line at top
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(x+2, y-lw/2+2, lw-4, 2);
    }
  }

  _drawHoldNote(ctx, obj, time, lw, k, ns) {
    const dir  = this.getDir(obj.col, k);
    const col  = this._noteColor(dir);
    const x    = this.colX(obj.col);
    const noteW = lw;

    // Clamp head to hit line if being held
    const isActive = this._noteHit[this.map.hitObjects.indexOf(obj)] === false &&
                     obj.startTime <= time && obj.endTime > time;

    const headY  = isActive ? this.canvas.height * this.settings.hitPosition
                             : this.noteY(obj.startTime, time);
    const tailY  = this.noteY(obj.endTime, time);

    // Don't draw if entirely off screen
    if (headY < -lw && tailY < -lw) return;
    if (headY > this.canvas.height + lw && tailY > this.canvas.height + lw) return;

    const bodyTop    = Math.min(headY, tailY);
    const bodyBottom = Math.max(headY, tailY);
    const bodyH      = bodyBottom - bodyTop;
    const bodyX      = x + noteW * 0.15;
    const bodyW      = noteW * 0.7;

    ctx.save();

    // Hold body
    if (ns?.holdBody && ns.holdBody.complete && ns.holdBody.naturalWidth > 0) {
      // Tile the hold body image vertically
      if (bodyH > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(bodyX, bodyTop, bodyW, bodyH);
        ctx.clip();
        const imgH = ns.holdBody.naturalHeight;
        const imgW = ns.holdBody.naturalWidth;
        const scale = bodyW / imgW;
        const tileH = imgH * scale;
        for (let ty = bodyTop; ty < bodyBottom; ty += tileH) {
          ctx.drawImage(ns.holdBody, bodyX, ty, bodyW, tileH);
        }
        ctx.restore();
      }
    } else {
      // Fallback: gradient body
      if (bodyH > 0) {
        const grad = ctx.createLinearGradient(bodyX, bodyTop, bodyX, bodyBottom);
        const c = col;
        grad.addColorStop(0, c.replace(')',',0.9)').replace('rgb','rgba'));
        grad.addColorStop(1, c.replace(')',',0.3)').replace('rgb','rgba'));
        ctx.fillStyle = grad;
        if (ctx.roundRect) ctx.roundRect(bodyX, bodyTop, bodyW, bodyH, 3);
        else ctx.rect(bodyX, bodyTop, bodyW, bodyH);
        ctx.fill();
      }
    }

    // Hold cap at tail
    if (ns?.holdCap && ns.holdCap.complete && ns.holdCap.naturalWidth > 0) {
      ctx.drawImage(ns.holdCap, bodyX, tailY - 8, bodyW, 16);
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(bodyX, tailY - 3, bodyW, 6);
    }

    ctx.restore();

    // Head note on top of body
    if (!isActive) {
      this._drawTapNote(ctx, x, headY, lw, dir, ns);
    }
  }

  _drawReceptors(ctx, W, H, k) {
    const hitY = H * this.settings.hitPosition;
    const lw   = this.settings.laneWidth;
    const ns   = this.noteskin;

    for (let col = 0; col < k; col++) {
      const x       = this.colX(col);
      const pressed = this.colStates[col]?.pressed;
      const dir     = this.getDir(col, k);
      const img     = pressed ? ns?.receptorsPress?.[dir] : ns?.receptorsGo?.[dir];

      if (img && img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, x, hitY - lw/2, lw, lw);
      } else {
        // Fallback
        const c = this._noteColor(dir);
        ctx.strokeStyle = c;
        ctx.lineWidth   = pressed ? 2.5 : 1.5;
        ctx.globalAlpha = pressed ? 1.0 : 0.45;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x+3, hitY-lw/2+3, lw-6, lw-6, 7);
        else ctx.rect(x+3, hitY-lw/2+3, lw-6, lw-6);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
  }

  _noteColor(dir) {
    const colors = { Left:'#4FC3F7', Down:'#81C784', Up:'#FF7043', Right:'#CE93D8' };
    return colors[dir] || '#ffffff';
  }

  // ── Judge effects ────────────────────────────────────
  _drawJudgeEffects(ctx, W, H, time) {
    this.judgements = this.judgements.filter(j => time - j.time < 700);

    // Pick most recent judgment for display
    if (!this.judgements.length) return;
    const j = this.judgements[this.judgements.length - 1];
    const age = (time - j.time) / 700;
    if (age > 1) return;

    const alpha  = Math.max(0, 1 - age * 1.6);
    const scaleT = 1 + age * 0.25;

    const ns = this.noteskin;
    const grades = {320:'w1',300:'w2',200:'w3',100:'w4',50:'w5',miss:'miss'};
    const gradeKey = grades[j.grade];
    const judgeImg = ns?.judgements?.[gradeKey];

    const pos = this._hudPos(this.settings.hudJudge, W, H);

    if (judgeImg && judgeImg.complete && judgeImg.naturalWidth > 0) {
      const iw = judgeImg.naturalWidth * scaleT;
      const ih = judgeImg.naturalHeight * scaleT;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(judgeImg, pos.x - iw/2, pos.y - ih/2, iw, ih);
      ctx.restore();
    } else {
      // Text fallback
      const labels = {320:'PERFECT',300:'GREAT',200:'GOOD',100:'OK',50:'MEH',miss:'MISS'};
      const colors = {320:'#b0e0ff',300:'#78f0a0',200:'#fff07c',100:'#f0a860',50:'#f06060',miss:'#606060'};
      const font   = this.settings.customFont || 'Nunito';
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(pos.x, pos.y);
      ctx.scale(scaleT, scaleT);
      ctx.font = `bold 20px "${font}", Nunito, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors[j.grade] || '#fff';
      ctx.shadowColor = colors[j.grade] || '#fff';
      ctx.shadowBlur = 12;
      ctx.fillText(labels[j.grade] || String(j.grade), 0, 0);
      ctx.restore();
    }
  }

  // ── HUD ─────────────────────────────────────────────
  _drawHUD(ctx, W, H, time) {
    const sc   = this.scoreState;
    const font = this.settings.customFont || 'Nunito';

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur  = 4;

    // Score
    {
      const pos = this._hudPos(this.settings.hudScore, W, H);
      ctx.font = `bold 26px "${font}", monospace`;
      ctx.textAlign = this.settings.hudScore.anchor.endsWith('r') ? 'right' :
                      this.settings.hudScore.anchor.endsWith('l') ? 'left' : 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(Math.round(sc.score)).padStart(8,'0'), pos.x, pos.y);
    }

    // Accuracy
    {
      const total = Object.values(sc.counts).reduce((a,b)=>a+b,0);
      const w = sc.counts[320]*320+sc.counts[300]*300+sc.counts[200]*200+sc.counts[100]*100+sc.counts[50]*50;
      const acc = total > 0 ? (w/(total*320)*100).toFixed(2) : '100.00';
      const pos = this._hudPos(this.settings.hudAcc, W, H);
      ctx.font = `bold 15px "${font}", sans-serif`;
      ctx.textAlign = this.settings.hudAcc.anchor.endsWith('r') ? 'right' :
                      this.settings.hudAcc.anchor.endsWith('l') ? 'left' : 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`${acc}%`, pos.x, pos.y);
    }

    // Combo
    if (sc.combo > 1) {
      const pos = this._hudPos(this.settings.hudCombo, W, H);
      ctx.font = `bold 34px "${font}", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(255,255,255,0.3)';
      ctx.shadowBlur  = 14;
      ctx.fillText(`${sc.combo}x`, pos.x, pos.y);
    }

    ctx.restore();
  }

  // Resolve anchor + offset to canvas pixel
  _hudPos(cfg, W, H) {
    const anchor = cfg.anchor || 'tl';
    let bx, by;
    if      (anchor.endsWith('l')) bx = 0;
    else if (anchor.endsWith('r')) bx = W;
    else                           bx = W/2;
    if      (anchor.startsWith('t')) by = 0;
    else if (anchor.startsWith('b')) by = H;
    else                             by = H/2;
    return { x: bx + (cfg.offsetX||0), y: by + (cfg.offsetY||0) };
  }
}
