import { MODULE_ID } from './constants.js';
import {
  FLAG_CAPACITY, FLAG_MOUNTABLE, FLAG_RIDEABLE, FLAG_DRAG_MOUNT, FLAG_GRANT_MODE,
  OPTION_DEFAULT, OPTION_ALWAYS, OPTION_NEVER,
} from './token-options.js';
import { log } from './logger.js';

/**
 * Mounting options in the Token Config sheet.
 *
 * Field names are real document paths (`flags.<module>.<key>`), so ApplicationV2
 * persists them on submit with no save handler of our own. That holds on both
 * sheets: PrototypeTokenConfig submits as `{prototypeToken: <form data>}`, so
 * the same relative path lands on the prototype token.
 *
 * Placement used to key off `[data-application-part="identity"]` alone and
 * return without injecting anything when that missed. The intent was caution,
 * but the effect was the opposite of safe — from the user's side a silently
 * skipped fieldset is indistinguishable from the module having no options at
 * all, and it is invisible in the log unless debug is on. Anywhere inside the
 * sheet's <form> is enough for the fields to round-trip, so `place` now works
 * down a cascade and always lands somewhere rather than giving up.
 */

const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const t = (key) => game.i18n.localize(key);

export function registerTokenConfig() {
  // PrototypeTokenConfig is a separate application class, so it needs its own
  // hook or the options would only be editable on placed tokens.
  for (const hook of ['renderTokenConfig', 'renderPrototypeTokenConfig']) {
    Hooks.on(hook, (app, element) => {
      try {
        injectFields(app, element);
      } catch (err) {
        // A broken injection must never stop Token Config rendering.
        log.error('failed to add token config fields', err);
      }
    });
  }
}

/** The <form> the sheet submits, so the fields are guaranteed to round-trip. */
function formOf(root) {
  if (root.tagName === 'FORM') return root;
  return root.closest?.('form') ?? root.querySelector('form') ?? root;
}

/** Warned at most once a session; the sheet is opened far too often to repeat. */
let warnedAboutPlacement = false;

/**
 * Put the fieldset where it will both show and submit.
 *
 * The Identity tab is the preferred home, but the selector that finds it is the
 * one part of this that varies by version, so it is tried three ways and then
 * abandoned in favour of the form itself. Landing at the bottom of the sheet is
 * a poor result; landing nowhere is a broken module.
 */
function place(root, fieldset) {
  const form = formOf(root);

  const strategies = [
    // The ApplicationV2 part, when parts carry their id in the DOM.
    ['identity part', () => root.querySelector('[data-application-part="identity"]')],

    // The tab section. Deliberately not a bare `[data-tab="identity"]`: that
    // also matches the tab *navigation* link, and the fieldset would be injected
    // inside a nav button where it is unusable.
    ['identity tab', () => [...root.querySelectorAll('[data-tab="identity"]')]
      .find(el => !el.closest('nav') && !['A', 'BUTTON'].includes(el.tagName))],

    // Whatever section holds the token's name field is the Identity tab under
    // any name, so this survives the part or the tab being renamed.
    ['name field section', () => root.querySelector('input[name="name"]')
      ?.closest('[data-application-part], .tab')],
  ];

  for (const [how, find] of strategies) {
    const anchor = find();
    if (anchor && form.contains(anchor)) {
      anchor.appendChild(fieldset);
      log.debug(`mount options placed in the ${how}`);
      return;
    }
  }

  // Last resort: above the buttons, so it is not stranded below the fold.
  const footer = form.querySelector('[data-application-part="footer"], .form-footer, footer');
  if (footer) footer.before(fieldset);
  else form.appendChild(fieldset);

  if (!warnedAboutPlacement) {
    warnedAboutPlacement = true;
    log.warn('could not find the Identity tab; mount options added to the end of the sheet instead');
  }
}

function injectFields(app, element) {
  // Duck-typed rather than `element instanceof HTMLElement`, which is false for
  // an element from another realm — a popped-out sheet is a separate window, so
  // its nodes fail that check against this window's HTMLElement. The old form
  // then fell through to `element[0]`, and because a <form> is indexable by its
  // own controls that yielded the first input instead of failing: every lookup
  // below silently returned nothing. jQuery objects have no `querySelector`, so
  // they still take the unwrap path.
  const root = typeof element?.querySelector === 'function' ? element : element?.[0];

  // `token` first. PrototypeTokenConfig extends ApplicationV2 rather than
  // DocumentSheetV2, so it has no `document` and no `object` — this used to
  // resolve to undefined and return, which is why the prototype token sheet
  // never showed these options on any version. TokenApplicationMixin defines
  // `token` on both sheets, and it resolves to the preview while one is open,
  // so the fields reflect unsaved edits rather than the stored document.
  const doc = app?.token ?? app?.document ?? app?.object;
  if (!root || typeof doc?.getFlag !== 'function') return;
  if (root.querySelector(`.${MODULE_ID}-config`)) return;

  const flag = (key) => doc.getFlag(MODULE_ID, key);
  const name = (key) => `flags.${MODULE_ID}.${key}`;

  /** Options for a three-way override, with the token's current choice marked. */
  const override = (key) => {
    const current = flag(key) ?? OPTION_DEFAULT;
    return [
      [OPTION_DEFAULT, 'S187TM.Option.Default'],
      [OPTION_ALWAYS, 'S187TM.Option.Always'],
      [OPTION_NEVER, 'S187TM.Option.Never'],
    ].map(([value, label]) =>
      `<option value="${value}" ${current === value ? 'selected' : ''}>${escape(t(label))}</option>`
    ).join('');
  };

  const fieldset = document.createElement('fieldset');
  fieldset.className = `${MODULE_ID}-config`;
  fieldset.innerHTML = `
    <legend>${escape(t('S187TM.Config.Legend'))}</legend>

    <div class="form-group">
      <label>${escape(t('S187TM.Config.Capacity'))}</label>
      <div class="form-fields">
        <input type="number" min="1" step="1" name="${name(FLAG_CAPACITY)}"
               value="${escape(flag(FLAG_CAPACITY) ?? '')}"
               placeholder="${escape(t('S187TM.Config.CapacityPlaceholder'))}">
      </div>
      <p class="hint">${escape(t('S187TM.Config.CapacityHint'))}</p>
    </div>

    <div class="form-group">
      <label>${escape(t('S187TM.Config.Mountable'))}</label>
      <div class="form-fields">
        <input type="checkbox" name="${name(FLAG_MOUNTABLE)}" ${flag(FLAG_MOUNTABLE) === true ? 'checked' : ''}>
      </div>
      <p class="hint">${escape(t('S187TM.Config.MountableHint'))}</p>
    </div>

    <div class="form-group">
      <label>${escape(t('S187TM.Config.DragMount'))}</label>
      <div class="form-fields">
        <select name="${name(FLAG_DRAG_MOUNT)}">${override(FLAG_DRAG_MOUNT)}</select>
      </div>
      <p class="hint">${escape(t('S187TM.Config.DragMountHint'))}</p>
    </div>

    <div class="form-group">
      <label>${escape(t('S187TM.Config.Rideable'))}</label>
      <div class="form-fields">
        <input type="checkbox" name="${name(FLAG_RIDEABLE)}" ${flag(FLAG_RIDEABLE) !== false ? 'checked' : ''}>
      </div>
      <p class="hint">${escape(t('S187TM.Config.RideableHint'))}</p>
    </div>

    <div class="form-group">
      <label>${escape(t('S187TM.Config.GrantMode'))}</label>
      <div class="form-fields">
        <select name="${name(FLAG_GRANT_MODE)}">${override(FLAG_GRANT_MODE)}</select>
      </div>
      <p class="hint">${escape(t('S187TM.Config.GrantModeHint'))}</p>
    </div>
  `;

  place(root, fieldset);
  // The sheet was sized before we added a fieldset to it.
  app.setPosition?.({ height: 'auto' });
}
