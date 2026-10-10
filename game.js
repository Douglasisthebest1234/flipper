(() => {
  'use strict';

  // ---------- Constants ----------
  const W = 900, H = 600;               // logical canvas size
  const CX = W / 2;
  const MAT_Y = 470, MAT_HALF = 170, FRAME_HALF = 200, GROUND_Y = 545;
  const FOOT = 48;                      // body origin -> feet when standing
  const GRAVITY = 1800;
  const V_MIN = 620, V_START = 720, V_MAX = 1500;
  const SPIN = { tuck: 17, pike: 11, layout: 7.5 };      // rad/s
  const SHAPE_MULT = { tuck: 1, pike: 1.3, layout: 1.7 };
  const SHAPE_NAME = { tuck: 'Tuck', pike: 'Pike', layout: 'Layout' };
  const TWIST_RATE = 14;                // rad/s
  const CONTACT_TIME = 0.22, CRASH_TIME = 0.9;
  const HEAD_TOL = 0.087, HEAD_BONUS = 1000000;   // secret: dead-vertical head landing (within ~5°)
  const CAM_TOP = 150;                  // camera pans up to keep the jumper below this
  const TAU = Math.PI * 2;
  const BEST_KEY = 'flipper.best';

  // ---------- DOM ----------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const el = {
    score: document.getElementById('score'),
    combo: document.getElementById('combo'),
    best: document.getElementById('best'),
    menu: document.getElementById('menu'),
  };

  function resize() {
    const scale = (canvas.clientWidth / W) * (window.devicePixelRatio || 1);
    canvas.width = Math.round(W * scale);
    canvas.height = Math.round(H * scale);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- Input ----------
  const KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    KeyF: 'twist', KeyK: 'twist',
    Space: 'jump',
  };
  const keys = { left: false, right: false, up: false, down: false, twist: false, jump: false };

  window.addEventListener('keydown', (e) => {
    const k = KEYMAP[e.code];
    if (k) {
      keys[k] = true;
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.code];
    if (k) keys[k] = false;
  });
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
  });

  document.querySelectorAll('.touch button').forEach((btn) => {
    const k = btn.dataset.key;
    const set = (v) => (e) => {
      e.preventDefault();
      keys[k] = v;
      btn.classList.toggle('down', v);
    };
    btn.addEventListener('pointerdown', set(true));
    btn.addEventListener('pointerup', set(false));
    btn.addEventListener('pointercancel', set(false));
    btn.addEventListener('pointerleave', set(false));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  document.getElementById('startBtn').addEventListener('click', () => tryStart());

  // ---------- State ----------
  const game = {
    state: 'menu',        // menu | play
    score: 0,
    combo: 0,
    best: loadBest(),
    tricks: new Map(),    // name -> { count, best }
    lastTrick: null,
  };

  const p = {
    state: 'air',         // air | contact | crash
    t: 0,
    y: MAT_Y - FOOT - 120,
    vy: 0,
    angle: 0,             // rotation since takeoff (+ = clockwise)
    angVel: 0,
    twist: 0,
    facing: 1,
    takeoffFacing: 1,
    tuck: 0, pike: 0, crouch: 0, armsUp: 0,
    bounceV: V_START,
    shapeRot: { tuck: 0, pike: 0, layout: 0 },
    lieAngle: 0,
  };

  let matDip = 0;         // current mat depression at centre (px)
  let wobbleT = 10;       // time since last launch
  let wobbleAmp = 0;
  let shake = 0;
  const popups = [];
  const particles = [];

  function loadBest() {
    try {
      return Number(localStorage.getItem(BEST_KEY)) || 0;
    } catch {
      return 0;
    }
  }
  function saveBest(v) {
    try {
      localStorage.setItem(BEST_KEY, String(v));
    } catch { /* storage unavailable */ }
  }

  function tryStart() {
    if (game.state === 'play') return;
    document.activeElement?.blur();   // so Space can't re-press the focused button
    game.state = 'play';
    game.score = 0;
    game.combo = 0;
    game.tricks.clear();
    game.lastTrick = null;
    popups.length = 0;
    particles.length = 0;
    p.bounceV = Math.max(p.bounceV, V_START);
    el.menu.classList.add('hidden');
    updateHud();
  }

  function updateHud() {
    el.score.textContent = game.score.toLocaleString();
    const mult = comboMult();
    el.combo.textContent = 'x' + (Number.isInteger(mult) ? mult : mult.toFixed(2).replace(/0$/, ''));
    el.combo.classList.toggle('hot', mult > 1);
    el.best.textContent = Math.max(game.best, game.score).toLocaleString();
  }

  // ---------- Tricks ----------
  function comboMult() {
    return Math.min(4, 1 + game.combo * 0.25);
  }

  function dominantShape() {
    const s = p.shapeRot;
    if (s.tuck >= s.pike && s.tuck >= s.layout) return 'tuck';
    return s.pike >= s.layout ? 'pike' : 'layout';
  }

  function twistLabel(h) {
    if (h === 1) return 'Half Twist';
    if (h === 2) return 'Full Twist';
    return `${h / 2} Twist`;
  }

  const SPECIAL = {
    'Front1': 'Barani', 'Front2': 'Front Full', 'Front3': 'Rudi', 'Front5': 'Randi',
    'Back2': 'Back Full', 'Back4': 'Double Full', 'Back6': 'Triple Full',
  };
  const COUNT = ['', '', 'Double ', 'Triple ', 'Quad '];

  function trickName(n, h, shape, facing) {
    const flips = Math.abs(n);
    if (flips === 0) return h > 0 ? twistLabel(h) : null;
    const dir = Math.sign(n) * facing > 0 ? 'Front' : 'Back';
    if (flips === 1 && h > 0 && SPECIAL[dir + h]) {
      return `${SPECIAL[dir + h]} (${SHAPE_NAME[shape].toLowerCase()})`;
    }
    const count = flips < COUNT.length ? COUNT[flips] : `${flips}x `;
    let name = `${count}${dir} ${SHAPE_NAME[shape]}`;
    if (h > 0) name += ` + ${twistLabel(h)}`;
    return name;
  }

  function addScore(pts) {
    game.score += pts;
    if (game.score > game.best) {
      game.best = game.score;
      saveBest(game.best);
    }
  }

  function scoreTrick(n, h, err) {
    const flips = Math.abs(n);
    const shape = dominantShape();
    const name = trickName(n, h, shape, p.takeoffFacing);
    if (!name) return;

    let pts = 50 * flips * (flips + 1) * SHAPE_MULT[shape] + 50 * h * (1 + flips);
    const tags = [];
    let color = '#ffffff';

    if (err < 0.17) {
      pts *= 1.5;
      tags.push('Perfect');
      color = '#ffe45c';
      burst(22, '#ffe45c');
    } else if (err >= 0.45) {
      pts *= 0.5;
      tags.push('Sloppy');
      color = '#ffb0a0';
    } else {
      burst(8, '#ffffff');
    }

    const seen = game.tricks.get(name);
    if (!seen) {
      pts *= 2;
      tags.push('NEW');
    } else if (game.lastTrick === name) {
      pts *= 0.5;
      tags.push('Repeat');
    }

    const mult = comboMult();
    pts *= mult;
    if (mult > 1) tags.push('x' + mult);
    pts = Math.max(10, Math.round(pts / 10) * 10);

    addScore(pts);
    if (err < 0.45) game.combo++;
    game.lastTrick = name;
    game.tricks.set(name, {
      count: (seen ? seen.count : 0) + 1,
      best: Math.max(seen ? seen.best : 0, pts),
    });
    popups.push({ text: name, sub: `+${pts}` + (tags.length ? '  ' + tags.join(' · ') : ''), color, life: 1.8 });
    updateHud();
  }

  function burst(count, color) {
    for (let i = 0; i < count; i++) {
      const a = -Math.PI * Math.random();
      const s = 120 + Math.random() * 320;
      particles.push({
        x: CX + (Math.random() - 0.5) * 40, y: MAT_Y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.5 + Math.random() * 0.5, color,
      });
    }
  }

  // ---------- Physics ----------
  function approach(cur, target, rate, dt) {
    return cur + (target - cur) * (1 - Math.exp(-rate * dt));
  }

  function input() {
    const on = game.state === 'play';
    return {
      dir: on ? (keys.right ? 1 : 0) - (keys.left ? 1 : 0) : 0,
      shape: on && keys.down ? 'tuck' : on && keys.up ? 'pike' : 'layout',
      twist: on && keys.twist,
      jump: on && keys.jump,
    };
  }

  function land() {
    const n = Math.round(p.angle / TAU);
    const err = Math.abs(p.angle - n * TAU);
    const h = Math.round(p.twist / Math.PI);
    const playing = game.state === 'play';

    p.t = 0;
    p.vy = 0;
    p.angVel = 0;
    if (h % 2 !== 0) p.facing *= -1;
    p.twist = 0;

    if (err > 0.9) {
      p.state = 'crash';
      p.lieAngle = Math.round((p.angle - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
      p.bounceV = V_MIN;
      shake = 0.35;
      if (playing) {
        if (Math.PI - err < HEAD_TOL) {
          addScore(HEAD_BONUS);
          burst(60, '#ffe45c');
          popups.push({ text: 'HEAD SPIKE!', sub: `+${HEAD_BONUS.toLocaleString()}`, color: '#ffe45c', life: 1.8 });
        } else {
          game.combo = 0;
          popups.push({ text: 'CRASH!', sub: 'combo lost', color: '#ff6b6b', life: 1.4 });
        }
        updateHud();
      }
    } else {
      p.state = 'contact';
      p.angle -= n * TAU;
      if (playing) scoreTrick(n, h, err);
    }
  }

  function launch() {
    const { jump } = input();
    p.bounceV = jump ? Math.min(V_MAX, p.bounceV + 120) : Math.max(V_MIN, p.bounceV - 70);
    p.state = 'air';
    p.y = MAT_Y - FOOT;
    p.vy = -p.bounceV;
    p.angle = 0;
    p.angVel = 0;
    p.twist = 0;
    p.takeoffFacing = p.facing;
    p.shapeRot.tuck = p.shapeRot.pike = p.shapeRot.layout = 0;
    wobbleT = 0;
    wobbleAmp = 6 + 12 * (p.bounceV / V_MAX);
  }

  function update(dt) {
    const inp = input();
    p.t += dt;
    wobbleT += dt;

    if (p.state === 'air') {
      const target = inp.dir * SPIN[inp.shape];
      p.angVel = approach(p.angVel, target, inp.dir ? 10 : 18, dt);
      const dA = p.angVel * dt;
      p.angle += dA;
      p.shapeRot[inp.shape] += Math.abs(dA);

      if (inp.twist) {
        p.twist += TWIST_RATE * dt;
      } else {
        // finish the half twist in progress
        const goal = Math.ceil(p.twist / Math.PI - 1e-6) * Math.PI;
        p.twist = Math.min(goal, p.twist + TWIST_RATE * dt);
      }

      p.tuck = approach(p.tuck, inp.shape === 'tuck' ? 1 : 0, 16, dt);
      p.pike = approach(p.pike, inp.shape === 'pike' ? 1 : 0, 16, dt);
      p.crouch = approach(p.crouch, 0, 20, dt);
      const reach = p.vy < 0 && inp.shape === 'layout' && Math.abs(p.angVel) < 1 ? 1 : 0;
      p.armsUp = approach(p.armsUp, reach, 10, dt);

      p.vy += GRAVITY * dt;
      p.y += p.vy * dt;
      matDip = -wobbleAmp * Math.exp(-7 * wobbleT) * Math.sin(30 * wobbleT);

      if (p.vy > 0 && p.y + FOOT >= MAT_Y) land();
    } else if (p.state === 'contact') {
      const k = Math.sin(Math.PI * Math.min(1, p.t / CONTACT_TIME));
      matDip = (14 + 22 * (p.bounceV / V_MAX)) * k;
      p.crouch = 0.9 * k;
      p.tuck = approach(p.tuck, 0, 30, dt);
      p.pike = approach(p.pike, 0, 30, dt);
      p.armsUp = approach(p.armsUp, 0, 20, dt);
      p.angle = approach(p.angle, 0, 25, dt);
      p.y = MAT_Y + matDip - pose().foot[1];
      if (p.t >= CONTACT_TIME) launch();
    } else {
      // crash: flop onto the mat, then get back up
      matDip = 16 * Math.exp(-5 * p.t) * Math.abs(Math.cos(11 * p.t)) + 4;
      p.angle = approach(p.angle, p.lieAngle, 14, dt);
      p.tuck = approach(p.tuck, 0, 10, dt);
      p.pike = approach(p.pike, 0, 10, dt);
      p.armsUp = approach(p.armsUp, 0.4, 10, dt);
      p.y = MAT_Y + matDip - 10;
      if (p.t >= CRASH_TIME) launch();
    }

    shake = Math.max(0, shake - dt);
    for (let i = popups.length - 1; i >= 0; i--) {
      popups[i].life -= dt;
      if (popups[i].life <= 0) popups.splice(i, 1);
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const q = particles[i];
      q.life -= dt;
      q.vy += 900 * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.life <= 0) particles.splice(i, 1);
    }
  }

  // ---------- Figure ----------
  // Angles are measured from "straight down", positive toward the facing side.
  function pose() {
    const { tuck, pike, crouch } = p;
    const up = p.armsUp * (1 - tuck) * (1 - pike);
    const lean = 0.5 * tuck + 0.9 * pike + 0.25 * crouch;
    const thigh = 2.2 * tuck + 1.9 * pike + 0.7 * crouch;
    const shin = -0.2 * tuck + 1.9 * pike - 0.6 * crouch;
    const uArm = 0.15 + 0.85 * tuck + 1.25 * pike + 2.65 * up + 0.3 * crouch;
    const lArm = 0.3 + 1.0 * tuck + 1.3 * pike + 2.6 * up + 0.5 * crouch;

    const hip = [0, 8];
    const shoulder = [hip[0] + Math.sin(lean) * 30, hip[1] - Math.cos(lean) * 30];
    const head = [shoulder[0] + Math.sin(lean) * 12, shoulder[1] - Math.cos(lean) * 12];
    const knee = [hip[0] + Math.sin(thigh) * 20, hip[1] + Math.cos(thigh) * 20];
    const foot = [knee[0] + Math.sin(shin) * 20, knee[1] + Math.cos(shin) * 20];
    const elbow = [shoulder[0] + Math.sin(uArm) * 15, shoulder[1] + Math.cos(uArm) * 15];
    const hand = [elbow[0] + Math.sin(lArm) * 15, elbow[1] + Math.cos(lArm) * 15];
    return { hip, shoulder, head, knee, foot, elbow, hand };
  }

  function drawFigure() {
    const j = pose();
    const sx = p.facing * Math.cos(p.twist);   // twist squashes the side profile
    const line = (pts, width, color) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * sx, pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * sx, pts[i][1]);
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.stroke();
    };

    ctx.save();
    ctx.translate(CX, p.y);
    ctx.rotate(p.angle);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    line([j.hip, j.knee, j.foot], 8, '#27336b');
    line([j.hip, j.shoulder], 12, '#ff7a3d');
    line([j.shoulder, j.elbow, j.hand], 6, '#f1c7a0');

    ctx.beginPath();
    ctx.arc(j.head[0] * sx, j.head[1], 9.5, 0, TAU);
    ctx.fillStyle = '#f1c7a0';
    ctx.fill();
    // hair + eye show which way the jumper faces
    ctx.beginPath();
    ctx.arc(j.head[0] * sx, j.head[1], 9.5, Math.PI * 1.05, Math.PI * 1.95);
    ctx.fillStyle = '#4a2f1b';
    ctx.fill();
    ctx.beginPath();
    ctx.arc((j.head[0] + 4.5) * sx, j.head[1] + 1, 1.5, 0, TAU);
    ctx.fillStyle = '#1c1c1c';
    ctx.fill();
    ctx.restore();
  }

  // ---------- Rendering ----------
  const clouds = [
    { x: 120, y: 90, s: 1 }, { x: 420, y: 55, s: 0.7 }, { x: 720, y: 120, s: 1.2 },
  ];

  function drawBackground(time) {
    const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    sky.addColorStop(0, '#4aa8ee');
    sky.addColorStop(1, '#c9ecff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#fff4b8';
    ctx.beginPath();
    ctx.arc(780, 80, 38, 0, TAU);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const c of clouds) {
      const x = ((c.x + time * 8 * c.s) % (W + 200)) - 100;
      ctx.beginPath();
      ctx.arc(x, c.y, 22 * c.s, 0, TAU);
      ctx.arc(x + 26 * c.s, c.y - 10 * c.s, 28 * c.s, 0, TAU);
      ctx.arc(x + 58 * c.s, c.y, 22 * c.s, 0, TAU);
      ctx.fill();
    }

    // distant hills
    ctx.fillStyle = '#8fd18a';
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.quadraticCurveTo(200, GROUND_Y - 120, 430, GROUND_Y);
    ctx.quadraticCurveTo(680, GROUND_Y - 90, W, GROUND_Y - 20);
    ctx.lineTo(W, GROUND_Y);
    ctx.fill();

    ctx.fillStyle = '#5cb85c';
    ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
    ctx.fillStyle = '#4ea64e';
    ctx.fillRect(0, GROUND_Y, W, 6);
  }

  function drawTrampoline() {
    ctx.lineCap = 'round';

    // shadow of the jumper
    const height = Math.max(0, MAT_Y - FOOT - p.y);
    const sw = Math.max(14, 46 - height * 0.08);
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0.06, 0.22 - height * 0.0004)})`;
    ctx.beginPath();
    ctx.ellipse(CX, GROUND_Y + 8, sw * 3.6, 9, 0, 0, TAU);
    ctx.fill();

    // legs
    ctx.strokeStyle = '#5b6478';
    ctx.lineWidth = 7;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(CX + s * (FRAME_HALF - 12), MAT_Y);
      ctx.lineTo(CX + s * (FRAME_HALF + 6), GROUND_Y + 6);
      ctx.stroke();
    }

    // springs
    ctx.strokeStyle = '#b9c0cf';
    ctx.lineWidth = 3;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(CX + s * FRAME_HALF, MAT_Y);
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const x = CX + s * (FRAME_HALF - (FRAME_HALF - MAT_HALF) * (i / steps));
        ctx.lineTo(x, MAT_Y + (i === steps ? 0 : i % 2 ? -4 : 4));
      }
      ctx.stroke();
    }

    // mat
    ctx.strokeStyle = '#1d2233';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(CX - MAT_HALF, MAT_Y);
    ctx.quadraticCurveTo(CX - 45, MAT_Y + matDip, CX, MAT_Y + matDip);
    ctx.quadraticCurveTo(CX + 45, MAT_Y + matDip, CX + MAT_HALF, MAT_Y);
    ctx.stroke();

    // frame pads
    ctx.strokeStyle = '#2f7fe0';
    ctx.lineWidth = 11;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(CX + s * (FRAME_HALF - 14), MAT_Y);
      ctx.lineTo(CX + s * (FRAME_HALF + 8), MAT_Y);
      ctx.stroke();
    }
  }

  function drawPowerMeter() {
    const x = 28, top = 150, h = 300, w = 14;
    const f = (p.bounceV - V_MIN) / (V_MAX - V_MIN);
    ctx.fillStyle = 'rgba(15,20,45,0.35)';
    ctx.fillRect(x, top, w, h);
    const grad = ctx.createLinearGradient(0, top + h, 0, top);
    grad.addColorStop(0, '#6ee06e');
    grad.addColorStop(1, '#ffb238');
    ctx.fillStyle = grad;
    ctx.fillRect(x, top + h * (1 - f), w, h * f);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, top, w, h);
    ctx.fillStyle = 'rgba(15,20,45,0.75)';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('POWER', x + w / 2 + 4, top - 8);
  }

  function outlinedText(text, x, y, font, fill, alpha) {
    ctx.globalAlpha = alpha;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(15,20,45,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  }

  function drawParticles() {
    for (const q of particles) {
      ctx.globalAlpha = Math.min(1, q.life * 2);
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - 3, q.y - 3, 6, 6);
    }
    ctx.globalAlpha = 1;
  }

  function drawOverlays() {
    // live preview of the trick in progress
    if (game.state === 'play' && p.state === 'air') {
      const n = Math.round(p.angle / TAU);
      const h = Math.round(p.twist / Math.PI);
      if (Math.abs(p.angle) > Math.PI * 1.2 || h > 0) {
        const name = trickName(n, h, dominantShape(), p.takeoffFacing);
        if (name) outlinedText(name + '…', CX, 40, '600 18px system-ui, sans-serif', '#ffffff', 0.75);
      }
    }

    popups.forEach((pop, i) => {
      const age = 1.8 - pop.life;
      const y = 150 - age * 30 - (popups.length - 1 - i) * 62;
      const alpha = Math.min(1, pop.life * 2.5);
      outlinedText(pop.text, CX, y, '800 30px system-ui, sans-serif', pop.color, alpha);
      if (pop.sub) outlinedText(pop.sub, CX, y + 26, '700 17px system-ui, sans-serif', '#ffffff', alpha);
    });
  }

  function draw(time) {
    ctx.save();
    if (shake > 0) {
      ctx.translate((Math.random() - 0.5) * shake * 30, (Math.random() - 0.5) * shake * 30);
    }
    const cam = Math.max(0, CAM_TOP - p.y);
    ctx.fillStyle = '#4aa8ee';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(0, cam);
    drawBackground(time);
    drawTrampoline();
    drawFigure();
    drawParticles();
    ctx.restore();
    drawPowerMeter();
    drawOverlays();
    ctx.restore();
  }

  // ---------- Loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(1 / 30, (now - last) / 1000);
    last = now;
    update(dt);
    draw(now / 1000);
    requestAnimationFrame(frame);
  }

  updateHud();
  requestAnimationFrame(frame);
})();
