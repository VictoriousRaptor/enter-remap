// Behavioral test for enter-remap/plugin.js — the REAL file, imported as-is.
// jsdom provides the DOM; a "core mimic" listener on window (bubble) replays
// composer/index.tsx handleEditorKeyDown's Enter branches:
//   (meta||ctrl) && !shift  → queue (composer.queue)
//   Enter && !shift         → send/steer (composer.send / composer.steer)
// so each press can be asserted end to end: which key the plugin swallowed,
// what synthetic event it re-dispatched, and which core branch fired.
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  `<!DOCTYPE html><html><body>
    <form id="composer-form">
      <div data-slot="composer-root">
        <div data-slot="composer-rich-input" contenteditable="true"><p>hello</p></div>
      </div>
      <button type="submit" id="send-btn">&#8593;</button>
    </form>
  </body></html>`,
  { url: 'https://hermes.local/' },
);

const window = dom.window;
const document = window.document;

globalThis.window = window;
globalThis.document = document;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;

const execCalls = [];
document.execCommand = (...args) => {
  execCalls.push(args[0]);
  return true;
};

const editor = document.querySelector('[data-slot="composer-rich-input"]');
if (!editor) throw new Error('fixture editor missing');

// The plugin's send fallback clicks the composer form's submit button.
const sendButton = document.getElementById('send-btn');
let sendClicks = 0;
sendButton.addEventListener('click', e => {
  sendClicks += 1;
  e.preventDefault(); // keep jsdom from attempting form navigation
});

// ---- spies (window level, attached once) ----
const seen = []; // every keydown reaching window capture (originals + synthetics)
window.addEventListener('keydown', e => seen.push(e), true);

const core = { send: 0, queue: 0 };
let coreDead = false;
document.body.addEventListener('keydown', e => {
  if (coreDead) return;
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return;
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
    core.queue += 1;
    e.preventDefault();
    return;
  }
  if (!e.shiftKey) {
    core.send += 1;
    e.preventDefault();
  }
});

// ---- document-capture spy MUST sit BEHIND the plugin's listener ----
let docCapture = [];
const docSpy = e => docCapture.push(e);
let docSpyAttached = false;

const plugin = (await import('../enter-remap/plugin.js')).default;

if (plugin.id !== 'enter-remap') throw new Error(`unexpected id: ${plugin.id}`);

const notes = globalThis.__notes = [];
const registered = [];
let storageSeed = {};
let dispose = null;
let ctx = null;

function makeCtx(seed) {
  const st = { ...seed };
  return {
    st,
    ctx: {
      storage: {
        get: (k, d) => (k in st ? st[k] : d),
        set: (k, v) => {
          st[k] = v;
        },
      },
      register: r => registered.push(r),
    },
  };
}

/** Detach spies → dispose plugin → re-register → re-attach doc spy behind it. */
function install(seed = {}) {
  if (docSpyAttached) {
    document.removeEventListener('keydown', docSpy, true);
    docSpyAttached = false;
  }
  if (dispose) {
    dispose();
    dispose = null;
  }
  registered.length = 0;
  const { ctx: c, st } = makeCtx(seed);
  ctx = c;
  ctx.__st = st;
  dispose = plugin.register(ctx);
  document.addEventListener('keydown', docSpy, true);
  docSpyAttached = true;
}

function press(init = {}) {
  seen.length = 0;
  docCapture.length = 0;
  execCalls.length = 0;
  const ev = new window.KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    code: 'Enter',
    composed: true,
    key: 'Enter',
    ...init,
  });
  if ('keyCode' in init) Object.defineProperty(ev, 'keyCode', { get: () => init.keyCode });
  if ('isComposing' in init) Object.defineProperty(ev, 'isComposing', { get: () => init.isComposing });
  editor.dispatchEvent(ev);
  return {
    ev,
    synth: seen.filter(x => x !== ev),
    swallowed: !docCapture.includes(ev), // plugin stopped propagation before the spy
  };
}

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) {
    pass += 1;
    console.log(`PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}

function coreSnapshot() {
  return { send: core.send, queue: core.queue };
}

// ===== T1: plain Enter → newline =====
install();
{
  const before = coreSnapshot();
  const r = press();
  ok(r.swallowed, 'T1 plain Enter swallowed by plugin');
  ok(execCalls.join() === 'insertLineBreak', 'T1 newline via execCommand(insertLineBreak)', execCalls);
  ok(r.synth.length === 0, 'T1 no synthetic event', r.synth.length);
  ok(core.send === before.send && core.queue === before.queue, 'T1 core untouched (no send/queue)');
  ok(r.ev.defaultPrevented, 'T1 original default prevented');
}

// ===== T2: Shift+Enter → queue (synthetic Ctrl+Enter → core.queue) =====
{
  const before = coreSnapshot();
  const r = press({ shiftKey: true });
  ok(r.swallowed, 'T2 Shift+Enter swallowed');
  ok(execCalls.length === 0, 'T2 no newline', execCalls);
  ok(r.synth.length === 1, 'T2 exactly one synthetic', r.synth.length);
  ok(
    r.synth[0] && r.synth[0].key === 'Enter' && r.synth[0].ctrlKey === true && r.synth[0].altKey === true && r.synth[0].metaKey === false && r.synth[0].shiftKey === false,
    'T2 synthetic is Ctrl+Alt+Enter',
    r.synth[0] && { ctrl: r.synth[0].ctrlKey, alt: r.synth[0].altKey, shift: r.synth[0].shiftKey },
  );
  ok(core.queue === before.queue + 1, 'T2 core queue fired once', { before, after: core });
  ok(core.send === before.send, 'T2 core send NOT fired', { before, after: core });
}

// ===== T3: Ctrl+Enter → send/steer (synthetic plain Enter → core.send) =====
{
  const before = coreSnapshot();
  const r = press({ ctrlKey: true });
  ok(r.swallowed, 'T3 Ctrl+Enter swallowed');
  ok(execCalls.length === 0, 'T3 no newline', execCalls);
  ok(r.synth.length === 1, 'T3 exactly one synthetic (no recursion)', r.synth.length);
  ok(
    r.synth[0] && r.synth[0].ctrlKey === false && r.synth[0].metaKey === false && r.synth[0].altKey === true && r.synth[0].shiftKey === false,
    'T3 synthetic is Alt+Enter',
    r.synth[0] && { ctrl: r.synth[0].ctrlKey, meta: r.synth[0].metaKey, alt: r.synth[0].altKey },
  );
  ok(core.send === before.send + 1, 'T3 core send fired once', { before, after: core });
  ok(core.queue === before.queue, 'T3 core queue NOT fired', { before, after: core });
}

// ===== T4: Cmd+Enter (meta) → same as Ctrl+Enter (core tests meta||ctrl) =====
{
  const before = coreSnapshot();
  const r = press({ metaKey: true });
  ok(r.swallowed, 'T4 Cmd+Enter swallowed');
  ok(r.synth.length === 1, 'T4 one synthetic', r.synth.length);
  ok(core.send === before.send + 1, 'T4 core send fired (mac-safe)', { before, after: core });
}

// ===== T5: Ctrl+Shift+Enter → untouched =====
{
  const before = coreSnapshot();
  const r = press({ ctrlKey: true, shiftKey: true });
  ok(!r.swallowed, 'T5 Ctrl+Shift+Enter passes through');
  ok(r.synth.length === 0, 'T5 no synthetic', r.synth.length);
  ok(execCalls.length === 0, 'T5 no newline', execCalls);
  ok(core.send === before.send && core.queue === before.queue, 'T5 core untouched');
}

// ===== T6: Alt+Enter → untouched =====
{
  const r = press({ altKey: true });
  ok(!r.swallowed, 'T6 Alt+Enter passes through');
  ok(r.synth.length === 0, 'T6 no synthetic', r.synth.length);
  ok(execCalls.length === 0, 'T6 no newline', execCalls);
}

// ===== T7: completion drawer open → everything untouched =====
{
  const drawer = document.createElement('div');
  drawer.setAttribute('data-slot', 'composer-completion-drawer');
  document.body.appendChild(drawer);
  for (const init of [{}, { shiftKey: true }, { ctrlKey: true }]) {
    const r = press(init);
    ok(!r.swallowed && r.synth.length === 0 && execCalls.length === 0, `T7 drawer open passthrough ${JSON.stringify(init)}`, {
      swallowed: r.swallowed,
      synth: r.synth.length,
      exec: execCalls,
    });
  }
  drawer.remove();
}

// ===== T8: IME composing → untouched =====
{
  const r = press({ isComposing: true });
  ok(!r.swallowed && execCalls.length === 0 && r.synth.length === 0, 'T8 isComposing passthrough', {
    swallowed: r.swallowed,
    exec: execCalls,
  });
}

// ===== T9: IME commit keyCode 229 → untouched =====
{
  const r = press({ keyCode: 229 });
  ok(!r.swallowed && execCalls.length === 0 && r.synth.length === 0, 'T9 keyCode 229 passthrough', {
    swallowed: r.swallowed,
    exec: execCalls,
  });
}

// ===== T10: palette commands — diagnose =====
{
  notes.length = 0;
  const diag = registered.find(r => r.data?.id === 'enter-remap.diagnose');
  ok(Boolean(diag), 'T10 diagnose command registered');
  diag.data.run();
  ok(notes.length === 1 && String(notes[0].message).includes('enter-remap'), 'T10 diagnose notify fired', notes);
}

// ===== T11: palette toggle off → stock map; on again → remap =====
{
  const toggle = registered.find(r => r.data?.id === 'enter-remap.toggle');
  ok(Boolean(toggle), 'T11 toggle command registered');
  notes.length = 0;
  toggle.data.run();
  ok(notes.length === 1 && ctx.__st.enabled === false, 'T11 toggle persisted off', ctx.__st);
  const r1 = press();
  ok(!r1.swallowed && execCalls.length === 0 && r1.synth.length === 0, 'T11 stock Enter passes while off', {
    swallowed: r1.swallowed,
    exec: execCalls,
  });
  const r2 = press({ shiftKey: true });
  ok(!r2.swallowed, 'T11 stock Shift+Enter passes while off');
  toggle.data.run();
  const r3 = press();
  ok(r3.swallowed && execCalls.join() === 'insertLineBreak', 'T11 remap active again after toggle on', execCalls);
}

// ===== T12: keydown outside the composer → untouched =====
{
  const ev = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Enter', key: 'Enter' });
  seen.length = 0;
  docCapture.length = 0;
  execCalls.length = 0;
  document.body.dispatchEvent(ev);
  ok(docCapture.includes(ev), 'T12 non-composer target not swallowed');
  ok(execCalls.length === 0 && seen.filter(x => x !== ev).length === 0, 'T12 no plugin action on body', { exec: execCalls });
}

// ===== T13: disabled at load (storage seed) → stock map =====
{
  install({ enabled: false });
  const r = press();
  ok(!r.swallowed && execCalls.length === 0, 'T13 disabled-at-load passes through', { swallowed: r.swallowed, exec: execCalls });
}

// ===== T14: dispose removes the listener =====
{
  install();
  if (dispose) {
    dispose();
    dispose = null;
  }
  const r = press();
  ok(!r.swallowed && execCalls.length === 0, 'T14 after dispose nothing intercepted', { swallowed: r.swallowed, exec: execCalls });
}

// ===== T15: TWO live instances of this plugin (duplicate load) =====
// The replaying flag is per-instance: without the cross-instance mark the
// second instance re-owns the first's synthetic as its own plain Enter and
// everything decays into newlines — exactly the field symptom. The mark +
// altKey must keep the full map alive.
{
  if (docSpyAttached) {
    document.removeEventListener('keydown', docSpy, true);
    docSpyAttached = false;
  }
  if (dispose) {
    dispose();
    dispose = null;
  }
  registered.length = 0;
  const first = makeCtx({});
  ctx = first.ctx;
  ctx.__st = first.st;
  dispose = plugin.register(ctx);
  const second = makeCtx({});
  const dispose2 = plugin.register(second.ctx);
  document.addEventListener('keydown', docSpy, true);
  docSpyAttached = true;

  let before = coreSnapshot();
  let r = press({ shiftKey: true });
  ok(r.swallowed && execCalls.length === 0 && core.queue === before.queue + 1, 'T15 dup instance: Shift+Enter still queues', {
    exec: execCalls,
    before,
    after: core,
  });
  before = coreSnapshot();
  r = press({ ctrlKey: true });
  ok(r.swallowed && execCalls.length === 0 && core.send === before.send + 1, 'T15 dup instance: Ctrl+Enter still sends', {
    exec: execCalls,
    before,
    after: core,
  });
  before = coreSnapshot();
  r = press();
  ok(r.swallowed && execCalls.join() === 'insertLineBreak' && core.send === before.send && core.queue === before.queue, 'T15 dup instance: Enter still newline', execCalls);
  dispose2();
}

// enter-swap-shaped sibling: fleps' decide() — plain Enter → newline,
// Shift+Enter → swallow + synthetic plain Enter (own replaying flag),
// ctrl/meta/alt → passthrough, IME/drawer → passthrough.
function makeSwap() {
  let replaying = false;
  const onKeyDown = e => {
    if (replaying) return;
    if (e.key !== 'Enter') return;
    if (!e.target.closest || !e.target.closest('[data-slot^="composer"]')) return;
    if (e.isComposing) return;
    if (document.querySelector('[data-slot="composer-completion-drawer"]')) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();
    if (!e.shiftKey) {
      document.execCommand('insertLineBreak');
      return;
    }
    replaying = true;
    try {
      const editorEl = e.target.closest(EDITOR_SELECTOR_H) || e.target;
      editorEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Enter', composed: true, key: 'Enter', shiftKey: false }));
    } finally {
      replaying = false;
    }
  };
  return {
    attach: () => document.addEventListener('keydown', onKeyDown, true),
    detach: () => document.removeEventListener('keydown', onKeyDown, true),
  };
}
const EDITOR_SELECTOR_H = '[data-slot="composer-rich-input"]';

function reinstallWithSiblings(order) {
  if (docSpyAttached) {
    document.removeEventListener('keydown', docSpy, true);
    docSpyAttached = false;
  }
  if (dispose) {
    dispose();
    dispose = null;
  }
  registered.length = 0;
  let swap = null;
  if (order === 'swap-first') {
    swap = makeSwap();
    swap.attach(); // older plugin → registered first
  }
  const fresh = makeCtx({});
  ctx = fresh.ctx;
  ctx.__st = fresh.st;
  dispose = plugin.register(ctx);
  if (order === 'swap-after') {
    swap = makeSwap();
    swap.attach(); // sibling loads after us → our listener is first
  }
  document.addEventListener('keydown', docSpy, true);
  docSpyAttached = true;
  return swap;
}

// ===== T16: enter-swap registered FIRST (installed earlier) =====
{
  const swap = reinstallWithSiblings('swap-first');

  // Enter: swap grabs it first and runs its own newline — same outcome we want.
  let before = coreSnapshot();
  let r = press();
  ok(execCalls.join() === 'insertLineBreak' && core.send === before.send && core.queue === before.queue, 'T16 swap-first: Enter newline (swap owns it, same result)', execCalls);

  // Ctrl+Enter: swap passes modified keys through; our alt-synthetic survives
  // the sibling and core sends.
  before = coreSnapshot();
  r = press({ ctrlKey: true });
  ok(execCalls.length === 0 && core.send === before.send + 1, 'T16 swap-first: Ctrl+Enter still sends through alt-synthetic', {
    exec: execCalls,
    before,
    after: core,
  });

  // Shift+Enter: DOCUMENTED CONFLICT — the sibling grabs the original first and
  // turns it into its own plain-Enter replay, which we then treat as newline.
  // Neither send nor queue fires; the only fix is disabling enter-swap.
  before = coreSnapshot();
  r = press({ shiftKey: true });
  ok(core.queue === before.queue && core.send === before.send, 'T16 swap-first: Shift+Enter blocked (documented: disable enter-swap for full map)', {
    exec: execCalls,
    before,
    after: core,
  });

  if (swap) swap.detach();
}

// ===== T17: enter-swap registered AFTER us → our listener is first =====
{
  const swap = reinstallWithSiblings('swap-after');

  let before = coreSnapshot();
  let r = press();
  ok(r.swallowed && execCalls.join() === 'insertLineBreak', 'T17 swap-after: Enter newline (ours first)', execCalls);

  before = coreSnapshot();
  r = press({ shiftKey: true });
  ok(r.swallowed && execCalls.length === 0 && core.queue === before.queue + 1, 'T17 swap-after: Shift+Enter queues', {
    exec: execCalls,
    before,
    after: core,
  });

  before = coreSnapshot();
  r = press({ ctrlKey: true });
  ok(r.swallowed && execCalls.length === 0 && core.send === before.send + 1, 'T17 swap-after: Ctrl+Enter sends', {
    exec: execCalls,
    before,
    after: core,
  });

  if (swap) swap.detach();
}

// ===== T18: send replay DEAD (no handler processes it) → submit-button fallback =====
{
  coreDead = true;
  const beforeClicks = sendClicks;
  const r = press({ ctrlKey: true });
  ok(r.swallowed && execCalls.length === 0, 'T18 dead replay: Ctrl+Enter still swallowed', execCalls);
  ok(sendClicks === beforeClicks + 1, 'T18 dead replay: fallback clicked the submit button', {
    before: beforeClicks,
    after: sendClicks,
  });
  coreDead = false;
}

// ===== T19: send replay alive → core sends, NO fallback click =====
{
  const beforeClicks = sendClicks;
  const before = coreSnapshot();
  press({ ctrlKey: true });
  ok(core.send === before.send + 1 && sendClicks === beforeClicks, 'T19 alive replay: core sent, no fallback click', {
    clicks: sendClicks,
    core,
  });
}

// ===== T20: turn busy → fallback refuses (that button is Stop while busy) =====
{
  globalThis.__busyOn = true;
  coreDead = true;
  const beforeClicks = sendClicks;
  press({ ctrlKey: true });
  ok(sendClicks === beforeClicks, 'T20 busy: fallback does not click (button would be Stop)', { clicks: sendClicks });
  globalThis.__busyOn = false;
  coreDead = false;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
