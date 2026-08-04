import {
  MODULE_ID, SETTING_HOSTILE_CHECK, SETTING_HOSTILE_DC,
} from '../constants.js';
import { isHostile } from '../mount.js';
import { log } from '../logger.js';

/**
 * dnd5e: subduing a hostile mount with an Animal Handling check.
 *
 * The only system-specific code in the module, and it is kept behind the
 * generic `preMount` gate rather than wired into mounting directly — the core
 * has no system dependency, and anyone on another system can register the same
 * hook with their own roll.
 *
 * Verified against dnd5e 5.3.3:
 *   rollSkill(config, dialog, message) => Promise<D20Roll[]|null>
 * The array is what the system's own callers destructure, and `null` means the
 * player dismissed the roll dialog.
 */

/** dnd5e's key for Animal Handling. */
export const ANIMAL_HANDLING = 'ani';

export function isDnd5e() {
  return game.system?.id === 'dnd5e';
}

function setting(key, fallback) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function registerDnd5e() {
  if (!isDnd5e()) {
    log.debug(`system is "${game.system?.id}"; skipping dnd5e integration`);
    return false;
  }
  Hooks.on(`${MODULE_ID}.preMount`, onPreMount);
  log.debug('registered dnd5e animal handling gate');
  return true;
}

function onPreMount(riderDoc, mountDoc, gate) {
  try {
    if (setting(SETTING_HOSTILE_CHECK, false) !== true) return;
    if (!isHostile(riderDoc, mountDoc)) return;

    const actor = riderDoc?.actor;
    // No actor, or an actor that cannot roll, must not become an unridable
    // token — fail open, since the check is a flourish and not a permission.
    if (typeof actor?.rollSkill !== 'function') {
      log.debug('rider cannot roll skills; allowing the mount');
      return;
    }

    gate.reason = 'S187TM.Dnd5e.Refused';
    gate.checks.push(subdue(actor, mountDoc));
  } catch (err) {
    // A thrown gate must never block mounting; that would be a broken table.
    log.error('animal handling gate failed; allowing the mount', err);
  }
}

/** @returns {Promise<boolean>} Whether the mount was subdued. */
async function subdue(actor, mountDoc) {
  const dc = Number(setting(SETTING_HOSTILE_DC, 15)) || 15;

  const rolls = await actor.rollSkill({
    skill: ANIMAL_HANDLING,
    // Shows the DC on the roll card and marks it a success or failure there,
    // rather than leaving the player to compare numbers by eye.
    target: dc,
  });

  // Cancelling the dialog is a decision not to try, not a reason to succeed.
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  if (!roll) {
    log.debug('animal handling roll cancelled; mount refused');
    return false;
  }

  const total = Number(roll.total ?? 0);
  const subdued = total >= dc;
  log.debug(`animal handling ${total} vs DC ${dc} on "${mountDoc?.name}" → ${subdued ? 'subdued' : 'refused'}`);
  return subdued;
}
