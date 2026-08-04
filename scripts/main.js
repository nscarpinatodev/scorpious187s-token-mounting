/**
 * Scorpious187's Token Mounting — entry point.
 * Foundry VTT v13.
 */

import { MODULE_ID } from './constants.js';
import { registerSettings } from './settings.js';
import { registerCarryAction, carryAction, CARRY_ACTION } from './carry-action.js';
import { registerMovementSync, resnap } from './movement.js';
import { registerMountSocket, registerCleanup, requestMount, requestDismount } from './mount.js';
import { registerTokenHUD } from './hud.js';
import { registerTokenConfig } from './token-config.js';
import { registerSteering, PILOT_SEAT } from './steering.js';
import { registerDnd5e, isDnd5e } from './systems/dnd5e.js';
import { registerMountDetection, looksLikeMount } from './mount-detection.js';
import { getMount, getRiders, allRiders, isMounted, isMount } from './relations.js';
import {
  capacityOf, isMountable, isRideable, acceptsDragMount, grantsOwnership,
} from './token-options.js';
import { generateSeats, seatPosition } from './seating.js';
import { log } from './logger.js';

Hooks.once('init', () => {
  registerSettings();
  // Must happen before any token prepares or moves, so the action exists by the
  // time a waypoint references it.
  registerCarryAction();
  registerMovementSync();
  // Before the HUD, so a drag that lands on a mount is handled by the same
  // validation the button uses rather than racing it.
  registerSteering();
  registerTokenHUD();
  registerTokenConfig();
  // On `init` so it is listening before the first token can be dropped.
  registerMountDetection();

  game.modules.get(MODULE_ID).api = Object.freeze({
    mount: requestMount,
    dismount: requestDismount,
    getMount,
    getRiders,
    allRiders,
    isMounted,
    isMount,
    resnap,
    pilotSeat: PILOT_SEAT,
    seating: { generateSeats, seatPosition },
    options: { capacityOf, isMountable, isRideable, acceptsDragMount, grantsOwnership },
    system: { isDnd5e },
    detection: { looksLikeMount },
  });

  log.info('Initialized');
});

Hooks.once('ready', () => {
  registerMountSocket();
  registerCleanup();
  // At `ready` rather than `init`: the gate only matters once someone can
  // actually mount, and game.system is settled either way.
  registerDnd5e();

  // If our own action failed to register we fall back to `displace`, which
  // still costs nothing but teleports riders instead of carrying them. Say so
  // rather than letting it be discovered as jerky movement mid-combat.
  const active = carryAction();
  if (active !== CARRY_ACTION && game.user.isGM) {
    log.warn(`carry action unavailable (using "${active ?? 'direct update'}"); riders will snap rather than travel`);
    ui.notifications.warn(game.i18n.localize('S187TM.Error.NoCarryAction'));
  }

  log.info('Ready');
});
