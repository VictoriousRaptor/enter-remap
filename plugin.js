// enter-remap — three-way rotation of the Hermes Desktop composer's Enter keys.
//
//   Enter            → insert a line break (multi-line composing)
//   Shift+Enter      → queue a follow-up while a turn runs (stock mod+Enter)
//   Ctrl/Cmd+Enter   → send / steer (stock plain Enter)
//
// Everything else is left alone: Ctrl+Shift+Enter, Alt combos, Enter inside the
// @ / '/' completion drawer, IME composition, and every other key.
//
// HOW IT WORKS, AND WHY IT IS A HACK
// Derived from fleps/hermes-desktop-enter-swap-plugin, same seam. Core marks
// `composer.send` (enter), `composer.newline` (shift+enter) and `composer.queue`
// (mod+enter) read-only in apps/desktop/src/lib/keybinds/actions.ts
// (KEYBIND_READONLY), and the composer's SDK surface only augments the
// composer — there is no supported API to rebind its keys. So this plugin
// intercepts keydown in the CAPTURE phase on `document`, ahead of React, and
// ROTATES the three keys by re-dispatching a synthetic event the app's own
// submit path understands:
//
//   plain Enter     → swallow + document.execCommand('insertLineBreak')
//                     (real beforeinput/input events → draft sync + undo intact)
//   Shift+Enter     → swallow + synthetic Ctrl+Alt+Enter → core runs composer.queue
//   Ctrl/Cmd+Enter  → swallow + synthetic Alt+Enter → core runs composer.send /
//                     composer.steer (composer/index.tsx handleEditorKeyDown;
//                     both Enter branches ignore alt — verified at v0.22.2,
//                     queue at `(metaKey || ctrlKey) && !shiftKey`, send at
//                     `!shiftKey`)
//
// Reimplementing submit would silently drop queue/steer/drain-queued behaviour —
// the synthetic event makes core's own handler do the work untouched.
//
// WHY THE SYNTHETICS CARRY `altKey` AND A MARK — a second capture listener on
// document (a duplicate load of this plugin, or another Enter-remapping plugin
// such as enter-swap running alongside) would otherwise eat our replay as its
// own plain Enter and run insertLineBreak instead of submit — every key turns
// into a newline and nothing ever sends. Two independent defences:
//   1. SYNTH_MARK stamped on every replayed event; any instance of this plugin
//      skips marked events outright (the replaying flag is per-instance, the
//      mark travels with the event object). Its value is a sequence number so
//      the bubble tracer can attribute each replay.
//   2. altKey: core's Enter branches never gate on alt, while sibling handlers
//      written like enter-swap pass ANY modified Enter straight through.
//      alt+Enter has no binding, menu accelerator or OS default anywhere in
//      the app.
//
// DEAD-REPLAY FALLBACK FOR SEND — a bubble tracer observes every replayed Enter
// after all in-page handlers ran (React's root onKeyDown included): if nobody
// called preventDefault on the send replay, the plugin clicks the composer
// form's submit button instead — the same core submit path, reached through a
// DOM affordance instead of the keyboard pipeline. Idle only: while a turn
// runs that button is Stop, and steering has no DOM twin. Queue has no DOM
// twin either; every replay outcome lands in the trace the diagnose command
// prints.
//
// PROBE / WARN — the load-time editor probe retries (8s / 30s / 90s) because a
// freshly (re)loaded plugin often runs while no chat is mounted; only the last
// empty probe warns. A live keydown whose target looks composer-ish but misses
// the slot contract warns once too.
//
// It leans on two internal DOM contracts (the `composer-rich-input` and
// `composer-completion-drawer` slot names). If a future release renames them,
// the plugin degrades to doing nothing and you get the stock key map back — it
// will never leave the composer broken.

import { host, PALETTE_AREA } from '@hermes/plugin-sdk';

// Primary contract: the composer's rich contentEditable carries this slot name
// (apps/desktop/src/app/chat/composer/rich-editor.ts). Fallback: any
// contentEditable living inside a composer-* slot.
const EDITOR_SLOT = 'composer-rich-input';
const EDITOR_SELECTOR = `[data-slot="${EDITOR_SLOT}"]`;
const COMPOSER_FALLBACK = '[data-slot^="composer"] [contenteditable="true"]';
const DRAWER_SLOT = 'composer-completion-drawer';
const STORAGE_KEY = 'enabled';
// Cross-instance replay tag. A plain (non-well-known) property on the event
// object: no DOM contract, it disappears with the event, and its value is the
// replay sequence number used by the bubble tracer.
const SYNTH_MARK = '__enterRemapSynth__';
const PROBE_DELAYS_MS = [8_000, 30_000, 90_000];
const TRACE_MAX = 24;

// The three-way rotation. `imeCommit` covers Chromium IME commits that arrive
// with keyCode 229 while isComposing is already false (macOS Chinese IME /
// some Windows IMEs) — core treats those as commit, never send, and so do we.
function decide(s) {
  if (s.key !== 'Enter') return 'passthrough';
  if (!s.active) return 'passthrough';
  if (s.composing || s.imeCommit) return 'passthrough';
  if (s.completionOpen) return 'passthrough';
  if (s.alt) return 'passthrough';
  // Ctrl/Cmd+Enter → send (replay Alt+Enter). With Shift held the chord is
  // not ours — leave Ctrl+Shift+Enter at app default.
  if (s.ctrl || s.meta) return s.shift ? 'passthrough' : 'send';
  // Shift+Enter → queue (replay Ctrl+Alt+Enter).
  if (s.shift) return 'queue';
  // Plain Enter → newline.
  return 'newline';
}

function probe() {
  return {
    completionDrawer: document.querySelectorAll(`[data-slot="${DRAWER_SLOT}"]`).length,
    composerSlots: [...document.querySelectorAll('[data-slot^="composer"]')]
      .map(el => el.dataset.slot)
      .filter((slot, i, all) => all.indexOf(slot) === i),
    editableInComposer: document.querySelectorAll(COMPOSER_FALLBACK).length,
    slotEditor: document.querySelectorAll(EDITOR_SELECTOR).length,
  };
}

const modsOf = e =>
  [e.ctrlKey && 'C', e.shiftKey && 'S', e.altKey && 'A', e.metaKey && 'M'].filter(Boolean).join('') || '-';

export default {
  id: 'enter-remap',
  name: 'Enter remap · Ctrl+Enter 发送 / Enter 换行 / Shift+Enter 排队',

  register(ctx) {
    let active = ctx.storage.get(STORAGE_KEY, true) !== false;
    let replaying = false;
    let synthSeq = 0;
    let warnedEditorMissing = false;
    let fallbackNotified = false;
    const trace = [];
    /** replay seq → did any handler preventDefault it (set at document bubble). */
    const seenAtBubble = new Map();

    const record = entry => {
      trace.push({ t: Date.now(), ...entry });
      if (trace.length > TRACE_MAX) trace.shift();
    };

    const editorOf = target => {
      if (!target || typeof target.closest !== 'function') return null;

      const bySlot = target.closest(EDITOR_SELECTOR);

      if (bySlot) return bySlot;

      const editable = target.closest('[contenteditable="true"]');

      return editable && editable.closest('[data-slot^="composer"]') ? editable : null;
    };

    /** Idle-only DOM twin of "send": the composer form's submit button. */
    const clickSendButton = editor => {
      try {
        if (host.state && host.state.busy && typeof host.state.busy.get === 'function' && host.state.busy.get()) {
          return 'busy';
        }

        const form = editor.closest('form');
        const button = form ? form.querySelector('button[type="submit"]') : null;

        if (!button) return 'no-button';
        if (button.disabled) return 'disabled';

        button.click();

        return 'clicked';
      } catch {
        return 'error';
      }
    };

    // Bubble-phase tracer: fires for a replay only after every in-page handler
    // (React's root onKeyDown included) had its chance — defaultPrevented here
    // means "core ran".
    const onBubbleTrace = event => {
      if (event.key !== 'Enter') return;

      const seq = event[SYNTH_MARK];

      record({
        ev: seq ? 'synth-end' : 'key-end',
        prevented: event.defaultPrevented,
        seq: seq || undefined,
        mods: modsOf(event),
      });

      if (seq) seenAtBubble.set(seq, event.defaultPrevented === true);
    };

    document.addEventListener('keydown', onBubbleTrace);

    const onKeyDown = event => {
      // Replays tagged by this plugin (any instance) pass straight through.
      if (replaying || event[SYNTH_MARK]) return;

      const editor = editorOf(event.target);

      if (!editor) {
        // Live contract check. The load-time probe can miss the composer (no
        // chat mounted at probe time); a real keypress on a composer-ish
        // element cannot — warn once and say so.
        if (
          event.key === 'Enter' &&
          !warnedEditorMissing &&
          event.target &&
          typeof event.target.closest === 'function' &&
          (event.target.closest('[contenteditable="true"]') || event.target.closest('[data-slot^="composer"]'))
        ) {
          warnedEditorMissing = true;
          record({ ev: 'warn-editor-miss' });
          host.notify({
            kind: 'warning',
            message:
              'enter-remap: 键位未接管——没认出输入框编辑器（内部 slot 契约可能变了），键位保持应用默认。⌘K 运行「诊断 Enter 键位重映射」查看详情。',
          });
        }

        return;
      }

      const action = decide({
        active,
        alt: event.altKey,
        completionOpen: Boolean(document.querySelector(`[data-slot="${DRAWER_SLOT}"]`)),
        composing: Boolean(event.isComposing || event.nativeEvent?.isComposing),
        ctrl: event.ctrlKey,
        imeCommit: event.keyCode === 229,
        key: event.key,
        meta: event.metaKey,
        shift: event.shiftKey,
      });

      record({ action, ev: 'key', mods: modsOf(event) });

      if (action === 'passthrough') return;

      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();

      if (action === 'newline') {
        document.execCommand('insertLineBreak');

        return;
      }

      replaying = true;

      let seq;

      try {
        // altKey rides along so any sibling capture listener (a duplicate
        // instance of this plugin, or another enter-remapping plugin) passes
        // the replay through instead of re-owning it; core's Enter branches
        // ignore alt, so send/queue routing is unchanged. Ctrl+Alt+Enter is
        // still the queue branch: it tests `(metaKey || ctrlKey) && !shiftKey`.
        const synth = new KeyboardEvent('keydown', {
          altKey: true,
          bubbles: true,
          cancelable: true,
          code: 'Enter',
          composed: true,
          ctrlKey: action === 'queue',
          key: 'Enter',
          metaKey: false,
          shiftKey: false,
        });

        seq = ++synthSeq;
        synth[SYNTH_MARK] = seq;
        editor.dispatchEvent(synth);
      } finally {
        replaying = false;
      }

      const handled = seenAtBubble.get(seq) === true;

      record({ action, ev: 'synth-result', handled, seq });

      // Dead-replay fallback — send only, idle only.
      if (action === 'send' && !handled) {
        const result = clickSendButton(editor);

        record({ ev: 'fallback', result });

        if (result === 'clicked' && !fallbackNotified) {
          fallbackNotified = true;
          host.notify({
            kind: 'info',
            message: 'enter-remap: 合成按键没被应用接住，已改为点击发送按钮兜底。请运行 ⌘K「诊断 Enter 键位重映射」并把结果反馈给哈基米。',
          });
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    PROBE_DELAYS_MS.forEach((delay, index) => {
      window.setTimeout(() => {
        const seen = probe();

        console.info('[enter-remap] probe', index, seen);

        const found = seen.slotEditor > 0 || seen.editableInComposer > 0;

        if (!found && index === PROBE_DELAYS_MS.length - 1) {
          host.notify({
            kind: 'warning',
            message: 'enter-remap: 三次探测都没找到输入框编辑器（当前没有打开的会话时属正常），键位保持应用默认。',
          });
        }
      }, delay);
    });

    ctx.register({
      id: 'diagnose',
      area: PALETTE_AREA,
      data: {
        id: 'enter-remap.diagnose',
        label: '诊断 Enter 键位重映射',
        keywords: ['enter', 'remap', 'debug', 'diagnose', '键位'],
        run: () => {
          const seen = probe();
          const tail = trace
            .slice(-10)
            .map(
              e =>
                `${new Date(e.t).toISOString().slice(11, 19)} ${e.ev}${e.action ? `:${e.action}` : ''}${e.mods && e.mods !== '-' ? `[${e.mods}]` : ''}${e.seq ? `#${e.seq}` : ''}${e.ev === 'synth-end' ? (e.prevented ? '=handled' : '=unhandled') : ''}${e.handled !== undefined ? (e.handled ? '=ok' : '=dead') : ''}${e.result ? `:${e.result}` : ''}`,
            )
            .join(' | ');

          console.info('[enter-remap] diagnose', { seen, trace });
          host.notify({
            kind: 'info',
            message: `enter-remap: 编辑器 slot ${seen.slotEditor}, composer 可编辑区 ${seen.editableInComposer}, slots[${seen.composerSlots.join(',')}]。最近按键: ${tail || '（无）'}`,
          });
        },
      },
    });

    ctx.register({
      id: 'toggle',
      area: PALETTE_AREA,
      data: {
        id: 'enter-remap.toggle',
        label: '切换 Enter 键位重映射',
        keywords: ['enter', 'remap', 'toggle', 'queue', 'send', '键位', '换行'],
        run: () => {
          active = !active;
          ctx.storage.set(STORAGE_KEY, active);
          host.notify({
            kind: 'info',
            message: active
              ? '已启用: Enter = 换行 · Shift+Enter = 排队 · Ctrl/Cmd+Enter = 发送/steer'
              : '已停用，恢复默认: Enter = 发送 · Shift+Enter = 换行 · Ctrl/Cmd+Enter = 排队',
          });
        },
      },
    });

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keydown', onBubbleTrace);
    };
  },
};
