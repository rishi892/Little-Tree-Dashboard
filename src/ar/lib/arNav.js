/**
 * AR Copilot guided "show me" walkthrough - the sibling of the cashflow
 * CfoNav. A little articulated robot WALKS (arms swing, legs step), raises its
 * arm and TAPS the sidebar item to open the page (the page auto-scrolls in
 * sync), then walks down to the first section and points at it. Blue-themed to
 * match the AR Copilot.
 *
 * Usage: arNavigate({ page, where }, navigate)
 *   - page      : sidebar id (overview / collections / sales / customers / ...)
 *   - where     : human label for the bubble (optional)
 *   - navigate  : fallback fn (useNav().navigate) used when the sidebar button
 *                 for `page` isn't in the DOM (e.g. filtered out by role).
 */

let runId = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// ── The robot (built from parts so its limbs can move + tap) ─────────────────

const STYLE_ID = 'ar-bot-style';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    .ar-fly { position:fixed; left:0; top:0; width:60px; height:78px; z-index:100001; pointer-events:none;
              filter: drop-shadow(0 9px 14px rgba(0,0,0,.32)); will-change: transform, opacity; }
    .ar-bot { position:absolute; inset:0; }
    .ar-bot .ant { position:absolute; left:50%; top:0; width:3px; height:9px; margin-left:-1.5px; background:#1d4ed8; border-radius:2px; }
    .ar-bot .ant::after { content:''; position:absolute; left:50%; top:-6px; width:8px; height:8px; margin-left:-4px; background:#22d3ee; border-radius:50%; box-shadow:0 0 7px #22d3ee; }
    .ar-bot .head { position:absolute; left:7px; top:8px; width:46px; height:33px; background:#eef4ff; border:2px solid #1d4ed8; border-radius:12px; box-sizing:border-box; }
    .ar-bot .screen { position:absolute; inset:5px; background:#0b1f4d; border-radius:8px; }
    .ar-bot .eye { position:absolute; top:9px; width:8px; height:8px; border-radius:50% 50% 45% 45%; background:#34e3f2; box-shadow:0 0 6px #34e3f2; }
    .ar-bot .eye.left { left:9px; } .ar-bot .eye.right { right:9px; }
    .ar-bot .arm { position:absolute; top:41px; width:8px; height:21px; background:#3b82f6; border:1.5px solid #1d4ed8; border-radius:5px; box-sizing:border-box; transform-origin:50% 4px; }
    .ar-bot .arm.left { left:3px; } .ar-bot .arm.right { right:3px; }
    .ar-bot .hand { position:absolute; left:-1px; bottom:-3px; width:9px; height:9px; background:#60a5fa; border:1.5px solid #1d4ed8; border-radius:50%; box-sizing:border-box; }
    .ar-bot .arm.right .finger { position:absolute; right:1px; bottom:-5px; width:3px; height:6px; background:#60a5fa; border-radius:2px; }
    .ar-bot .body { position:absolute; left:13px; top:40px; width:34px; height:24px; background:#2563eb; border:2px solid #1d4ed8; border-radius:10px; box-sizing:border-box; }
    .ar-bot .body::after { content:''; position:absolute; left:50%; top:7px; width:8px; height:8px; margin-left:-4px; background:#93c5fd; border-radius:50%; }
    .ar-bot .leg { position:absolute; top:60px; width:10px; height:15px; background:#1d4ed8; border-radius:5px; transform-origin:50% 2px; }
    .ar-bot .leg.left { left:18px; } .ar-bot .leg.right { right:18px; }
    .ar-bot .leg::after { content:''; position:absolute; left:-2px; bottom:-3px; width:13px; height:6px; background:#0e2f86; border-radius:4px; }

    .ar-fly.ar-walking .ar-bot { animation: arBodyBob .44s ease-in-out infinite; }
    .ar-fly.ar-walking .arm.left  { animation: arSwingA .44s ease-in-out infinite; }
    .ar-fly.ar-walking .arm.right { animation: arSwingB .44s ease-in-out infinite; }
    .ar-fly.ar-walking .leg.left  { animation: arStepB .44s ease-in-out infinite; }
    .ar-fly.ar-walking .leg.right { animation: arStepA .44s ease-in-out infinite; }
    @keyframes arBodyBob { 0%,100%{ transform:translateY(0) } 25%,75%{ transform:translateY(-3px) } }
    @keyframes arSwingA { 0%,100%{ transform:rotate(32deg) }  50%{ transform:rotate(-32deg) } }
    @keyframes arSwingB { 0%,100%{ transform:rotate(-32deg) } 50%{ transform:rotate(32deg) } }
    @keyframes arStepA  { 0%,100%{ transform:rotate(26deg) }  50%{ transform:rotate(-26deg) } }
    @keyframes arStepB  { 0%,100%{ transform:rotate(-26deg) } 50%{ transform:rotate(26deg) } }

    /* TAP - raise the right arm and jab the finger */
    .ar-fly.ar-tap .arm.right { animation: arTapArm .72s ease-in-out; }
    @keyframes arTapArm { 0%{transform:rotate(-12deg)} 30%{transform:rotate(-108deg)} 48%{transform:rotate(-80deg)} 64%{transform:rotate(-104deg)} 100%{transform:rotate(-12deg)} }

    /* IDLE - friendly little wave with the right arm while standing */
    .ar-fly:not(.ar-walking):not(.ar-tap) .arm.right { animation: arWaveArm 1.1s ease-in-out infinite; }
    @keyframes arWaveArm { 0%,100%{ transform:rotate(-12deg) } 50%{ transform:rotate(-46deg) } }

    .ar-fly-bubble { position:fixed; left:0; top:0; z-index:100002; background:#1e40af; color:#fff;
      padding:6px 11px; border-radius:12px; font-size:12.5px; font-weight:600; pointer-events:none;
      opacity:0; transition:opacity .3s ease; box-shadow:0 6px 18px rgba(0,0,0,.28); white-space:nowrap; }
    .ar-ripple { position:fixed; width:34px; height:34px; margin:-17px 0 0 -17px; border-radius:50%;
      border:2px solid #3b82f6; background:rgba(59,130,246,.22); z-index:100000; pointer-events:none; }

    @keyframes arPulse {
      0%   { box-shadow: 0 0 0 0 rgba(59,130,246,0.55); }
      70%  { box-shadow: 0 0 0 16px rgba(59,130,246,0); }
      100% { box-shadow: 0 0 0 0 rgba(59,130,246,0); }
    }
    .ar-highlight {
      animation: arPulse 1.3s ease-out 2;
      outline: 2px solid #3b82f6;
      outline-offset: 3px;
      border-radius: 10px;
      scroll-margin-top: 90px;
    }
  `;
  document.head.appendChild(s);
}

function makeBot() {
  ensureStyle();
  const el = document.createElement('div');
  el.className = 'ar-fly';
  el.innerHTML = `
    <div class="ar-bot">
      <div class="ant"></div>
      <div class="arm left"><div class="hand"></div></div>
      <div class="arm right"><div class="hand"></div><div class="finger"></div></div>
      <div class="body"></div>
      <div class="leg left"></div>
      <div class="leg right"></div>
      <div class="head"><div class="screen"></div><div class="eye left"></div><div class="eye right"></div></div>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function makeBubble() {
  const b = document.createElement('div');
  b.className = 'ar-fly-bubble';
  document.body.appendChild(b);
  return b;
}

// ── Motion helpers ───────────────────────────────────────────────────────────

/** Smoothly scroll the window to `toY` over `dur` ms. */
function animateScroll(toY, dur) {
  const fromY = window.scrollY;
  if (Math.abs(toY - fromY) < 3) return Promise.resolve();
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / dur);
      window.scrollTo(0, fromY + (toY - fromY) * easeInOut(t));
      if (t < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Move the robot from `from` to `to` at walking pace; limbs animate via CSS. */
function walkBot(bot, from, to, dur) {
  bot.classList.add('ar-walking');
  return new Promise((resolve) => {
    const a = bot.animate(
      [{ transform: `translate(${from.x}px, ${from.y}px)` }, { transform: `translate(${to.x}px, ${to.y}px)` }],
      { duration: dur, easing: 'linear', fill: 'forwards' },
    );
    a.onfinish = () => { bot.classList.remove('ar-walking'); resolve(); };
  });
}

/** Walk to an element at its CURRENT viewport spot, no scrolling (for the
 *  sticky sidebar, which is always on screen). Returns the resting spot. */
function walkToFixed(bot, from, el, dur) {
  const rect = el.getBoundingClientRect();
  const to = {
    x: Math.max(8, Math.min(window.innerWidth - 68, rect.right - 14)),
    y: Math.max(8, Math.min(window.innerHeight - 86, rect.top + rect.height / 2 - 40)),
  };
  return walkBot(bot, from, to, dur).then(() => to);
}

/** Walk to an element while the page auto-scrolls so the element lands at
 *  `frac` of the viewport height. Returns the robot's resting spot. */
async function walkToElement(bot, from, el, dur, frac) {
  const vh = window.innerHeight;
  const rect = el.getBoundingClientRect();
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - vh);
  const targetScrollY = Math.max(0, Math.min(maxScroll, window.scrollY + rect.top - vh * frac));
  const delta = targetScrollY - window.scrollY;
  const postTop = rect.top - delta;
  const to = {
    x: Math.max(8, Math.min(window.innerWidth - 68, rect.left + rect.width / 2 - 30)),
    y: Math.max(8, Math.min(vh - 86, postTop - 84)),
  };
  await Promise.all([animateScroll(targetScrollY, dur), walkBot(bot, from, to, dur)]);
  return to;
}

function ripple(x, y) {
  const r = document.createElement('div');
  r.className = 'ar-ripple';
  r.style.left = `${x}px`;
  r.style.top = `${y}px`;
  document.body.appendChild(r);
  r.animate([{ transform: 'scale(.25)', opacity: 0.75 }, { transform: 'scale(1.7)', opacity: 0 }], { duration: 560, easing: 'ease-out' })
    .onfinish = () => r.remove();
}

/** Play the tap gesture; fire `onTap` at the jab and ripple at `point`. */
function tapAt(bot, point, onTap) {
  bot.classList.add('ar-tap');
  return new Promise((resolve) => {
    window.setTimeout(() => { ripple(point.x, point.y); onTap(); }, 320);
    window.setTimeout(() => { bot.classList.remove('ar-tap'); resolve(); }, 760);
  });
}

function say(bubble, at, text) {
  bubble.textContent = text;
  bubble.style.transform = `translate(${Math.min(window.innerWidth - 170, at.x + 56)}px, ${Math.max(6, at.y + 8)}px)`;
  bubble.style.opacity = '1';
}

/** The first meaningful content block on the currently rendered page. */
function findSection() {
  return document.querySelector(
    '.dash-content .kpi, .dash-content .table-card, .dash-content .chart-card, .dash-content .alert-card',
  );
}

async function walkthrough(detail, navigate, my) {
  const bot = makeBot();
  const bubble = makeBubble();
  let pos = { x: window.innerWidth - 92, y: window.innerHeight - 112 };
  bot.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  bot.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, fill: 'forwards' });

  const cleanup = () => { bot.remove(); bubble.remove(); };
  const aborted = () => my !== runId;

  // STEP 1 - walk to the sidebar item and TAP it to open the page.
  const navBtn = detail.page
    ? document.querySelector(`.sidebar-link[data-nav-id="${detail.page}"]`)
    : null;

  if (navBtn) {
    pos = await walkToFixed(bot, pos, navBtn, 1650); if (aborted()) return cleanup();
    say(bubble, pos, 'Opening this for you');
    const nr = navBtn.getBoundingClientRect();
    await tapAt(bot, { x: nr.left + nr.width / 2, y: nr.top + nr.height / 2 }, () => {
      navBtn.classList.add('ar-highlight');
      navBtn.click();               // real navigation via the sidebar's onClick
    });
    if (aborted()) return cleanup();
    await wait(500); navBtn.classList.remove('ar-highlight');
    bubble.style.opacity = '0';
    await wait(500); if (aborted()) return cleanup();
  } else {
    // Sidebar button not present (page filtered by role) - navigate directly.
    navigate?.(detail.page);
    await wait(700);
  }

  // STEP 2 - the new page has rendered; walk down to its first section and point.
  let el = null;
  for (let i = 0; i < 16 && !el; i++) {
    el = findSection();
    if (!el) await wait(130);
  }
  if (aborted()) return cleanup();

  if (el) {
    pos = await walkToElement(bot, pos, el, 1750, 0.32); if (aborted()) return cleanup();
    const sr = el.getBoundingClientRect();
    await tapAt(bot, { x: sr.left + Math.min(70, sr.width / 2), y: sr.top + 18 }, () => {
      el.classList.add('ar-highlight');
    });
    if (aborted()) return cleanup();
    say(bubble, pos, 'Here it is 👇');
    await wait(2600); if (aborted()) return cleanup();
    el.classList.remove('ar-highlight');
  }

  bubble.style.opacity = '0';
  bot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, fill: 'forwards' }).onfinish = cleanup;
}

/** Public entry: run the guided walkthrough to `detail.page`. */
export function arNavigate(detail, navigate) {
  const my = ++runId;
  document.querySelectorAll('.ar-fly, .ar-fly-bubble, .ar-ripple').forEach((n) => n.remove());
  window.setTimeout(() => { void walkthrough(detail, navigate, my).catch(() => { /* best-effort */ }); }, 120);
}
