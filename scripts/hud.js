import { MODULE_ID } from './constants.js';
import { isMounted, getMount } from './relations.js';
import { requestMount, requestDismount, validateMount } from './mount.js';
import { log } from './logger.js';

/**
 * Token HUD controls.
 *
 * Mounting needs two tokens, and the HUD only gives us one. Rather than
 * inventing a modal picker, the second is taken from the user's current
 * *target* — the same gesture used for attacks, so it needs no explanation.
 */
export function registerTokenHUD() {
  Hooks.on('renderTokenHUD', (hud, html, data) => {
    try {
      const root = html instanceof HTMLElement ? html : html?.[0];
      const tokenDoc = hud.object?.document;
      if (!root || !tokenDoc) return;
      if (root.querySelector(`.${MODULE_ID}-control`)) return;

      const column = root.querySelector('.col.left') ?? root.querySelector('.left');
      if (!column) return;

      const mounted = isMounted(tokenDoc);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `control-icon ${MODULE_ID}-control`;
      button.dataset.action = mounted ? 'dismount' : 'mount';
      button.innerHTML = `<i class="fas ${mounted ? 'fa-person-walking-arrow-right' : 'fa-horse'}"></i>`;
      button.dataset.tooltip = game.i18n.localize(
        mounted ? 'S187TM.HUD.Dismount' : 'S187TM.HUD.Mount',
      );

      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (mounted) {
          await requestDismount(tokenDoc);
          hud.render();
          return;
        }

        const target = game.user.targets.first()?.document;
        if (!target) {
          ui.notifications.info(game.i18n.localize('S187TM.HUD.TargetFirst'));
          return;
        }

        const error = validateMount(tokenDoc, target);
        if (error) {
          ui.notifications.warn(game.i18n.localize(error));
          return;
        }

        await requestMount(tokenDoc, target);
        hud.render();
      });

      column.appendChild(button);
    } catch (err) {
      // A broken HUD injection must never stop the HUD rendering.
      log.error('failed to add token HUD control', err);
    }
  });
}

/** Small status readout so a GM can see what is riding what. */
export function describeMount(tokenDoc) {
  const mount = getMount(tokenDoc);
  return mount ? game.i18n.format('S187TM.Status.RidingOn', { name: mount.name }) : '';
}
