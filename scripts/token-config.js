import { MODULE_ID } from './constants.js';
import {
  FLAG_CAPACITY, FLAG_MOUNTABLE, FLAG_RIDEABLE, FLAG_DRAG_MOUNT, FLAG_GRANT_MODE,
  OPTION_DEFAULT, OPTION_ALWAYS, OPTION_NEVER,
} from './token-options.js';
import { log } from './logger.js';

/**
 * Mounting options in the Token Config sheet.
 *
 * v13/v14 Token Config is an ApplicationV2 whose parts render as
 * `[data-application-part="<id>"]`, so the Identity tab is a stable anchor —
 * more stable than any class name inside it. If the anchor is ever missing we
 * do nothing rather than guess, because a half-injected fieldset is worse than
 * no fieldset: the fields would submit and silently not round-trip.
 *
 * Field names are real document paths (`flags.<module>.<key>`), so ApplicationV2
 * persists them on submit with no save handler of our own.
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

function injectFields(app, element) {
  const root = element instanceof HTMLElement ? element : element?.[0];
  const doc = app?.document ?? app?.object;
  if (!root || !doc?.getFlag) return;
  if (root.querySelector(`.${MODULE_ID}-config`)) return;

  const anchor = root.querySelector('[data-application-part="identity"]')
    ?? root.querySelector('.tab[data-tab="identity"]');
  if (!anchor) {
    log.debug('token config identity part not found; skipping mount options');
    return;
  }

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

  anchor.appendChild(fieldset);
  // The sheet was sized before we added a fieldset to it.
  app.setPosition?.({ height: 'auto' });
}
