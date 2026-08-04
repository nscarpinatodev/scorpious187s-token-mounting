import {
  MODULE_ID, SETTING_DETECT_MOUNTS, SETTING_MOUNT_NAMES,
} from './constants.js';
import { FLAG_MOUNTABLE } from './token-options.js';
import { log } from './logger.js';

/**
 * Recognising a mount as it is dragged onto the scene.
 *
 * There is no data flag in any system that says "this creature is ridden" — 5e
 * statblocks for a riding horse and a wolf are structurally identical. Creature
 * type and size are no better: plenty of Large beasts are enemies, and plenty of
 * mounts are Medium. So this matches on name, which is the signal that actually
 * carries the information, and exposes the list so a table with homebrew mounts
 * can extend it rather than filing a bug.
 *
 * Names are matched on word boundaries: "horse" should not fire on "Horseshoe
 * Crab", and a list that produced false positives would be worse than no list —
 * every wolf in the scene silently becoming a drop target.
 */

/**
 * Deliberately conservative. Everything here is ridden far more often than it is
 * fought; ambiguous cases (wolf, spider, bear) are left out and can be added per
 * world. A false negative costs one checkbox, a false positive is a mystery.
 */
export const DEFAULT_MOUNT_NAMES = [
  'horse', 'warhorse', 'steed', 'pony', 'mule', 'donkey', 'camel',
  'elephant', 'mammoth', 'rhinoceros', 'giant elk', 'giant goat',
  'griffon', 'gryphon', 'hippogriff', 'pegasus', 'wyvern',
  'giant lizard', 'riding lizard', 'dire wolf', 'saddle',
];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function setting(key, fallback) {
  try {
    const value = game.settings.get(MODULE_ID, key);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/** Parse the configured comma-separated list into usable terms. */
export function configuredNames() {
  const raw = setting(SETTING_MOUNT_NAMES, '');
  const terms = String(raw)
    .split(',')
    .map(term => term.trim().toLowerCase())
    .filter(Boolean);
  return terms.length ? terms : DEFAULT_MOUNT_NAMES;
}

/**
 * Does this name read as a creature that gets ridden?
 *
 * `names` is a parameter rather than read from settings so this stays a pure
 * function — it is the only part of detection worth testing offline.
 *
 * @param {string} name
 * @param {string[]} [names]
 * @returns {boolean}
 */
export function looksLikeMount(name, names = DEFAULT_MOUNT_NAMES) {
  const haystack = String(name ?? '').toLowerCase();
  if (!haystack.trim()) return false;
  return names.some(term => new RegExp(`\\b${escapeRegex(term)}\\b`).test(haystack));
}

export function registerMountDetection() {
  Hooks.on('preCreateToken', (tokenDoc, data) => {
    try {
      if (setting(SETTING_DETECT_MOUNTS, true) !== true) return;

      // An explicit choice already on the prototype token is a decision someone
      // made; guessing over the top of it would be worse than not guessing.
      if (tokenDoc.getFlag?.(MODULE_ID, FLAG_MOUNTABLE) !== undefined) return;

      // Both names, because a token is often renamed ("Bréagh") while the actor
      // keeps the species ("Riding Horse") — and sometimes the reverse.
      const subject = `${data?.name ?? tokenDoc.name ?? ''} ${tokenDoc.actor?.name ?? ''}`;
      if (!looksLikeMount(subject, configuredNames())) return;

      // Written into the creation data rather than as a follow-up update, so the
      // token is never briefly on the canvas in the wrong state.
      //
      // Only `mountable` is set. Drag-targeting deliberately stays with the
      // world setting: `acceptsDragMount` already requires `mountable`, so
      // turning drag-to-mount on now reaches recognised mounts and nothing else.
      // Forcing it here would override a GM who turned it off.
      tokenDoc.updateSource({
        [`flags.${MODULE_ID}.${FLAG_MOUNTABLE}`]: true,
      });

      log.debug(`recognised "${subject.trim()}" as a mount`);
    } catch (err) {
      // Detection is a convenience; it must never stop a token being created.
      log.error('mount detection failed; creating the token unchanged', err);
    }
  });
}
