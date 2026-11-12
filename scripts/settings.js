import {
  MODULE_ID, SETTING_GRANT_OWNERSHIP, SETTING_MAX_RIDERS, SETTING_DEBUG,
  SETTING_DRAG_TO_MOUNT, SETTING_HOSTILE_CHECK, SETTING_HOSTILE_DC,
  SETTING_DETECT_MOUNTS, SETTING_MOUNT_NAMES, SETTING_SEAT_LAYOUT,
} from './constants.js';
import { isDnd5e } from './systems/dnd5e.js';
import { DEFAULT_MOUNT_NAMES } from './mount-detection.js';
import { SEAT_LAYOUTS, DEFAULT_SEAT_LAYOUT } from './seating.js';
import { SEAT_LAYOUT_LABELS } from './token-options.js';
import { reseatAll } from './movement.js';

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_GRANT_OWNERSHIP, {
    name: game.i18n.localize('S187TM.Settings.GrantOwnership'),
    hint: game.i18n.localize('S187TM.Settings.GrantOwnershipHint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTING_MAX_RIDERS, {
    name: game.i18n.localize('S187TM.Settings.MaxRiders'),
    hint: game.i18n.localize('S187TM.Settings.MaxRidersHint'),
    scope: 'world',
    config: true,
    type: Number,
    default: 8,
  });

  game.settings.register(MODULE_ID, SETTING_DRAG_TO_MOUNT, {
    name: game.i18n.localize('S187TM.Settings.DragToMount'),
    hint: game.i18n.localize('S187TM.Settings.DragToMountHint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTING_DETECT_MOUNTS, {
    name: game.i18n.localize('S187TM.Settings.DetectMounts'),
    hint: game.i18n.localize('S187TM.Settings.DetectMountsHint'),
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, SETTING_MOUNT_NAMES, {
    name: game.i18n.localize('S187TM.Settings.MountNames'),
    hint: game.i18n.localize('S187TM.Settings.MountNamesHint'),
    scope: 'world',
    config: true,
    type: String,
    default: DEFAULT_MOUNT_NAMES.join(', '),
  });

  game.settings.register(MODULE_ID, SETTING_SEAT_LAYOUT, {
    name: game.i18n.localize('S187TM.Settings.SeatLayout'),
    hint: game.i18n.localize('S187TM.Settings.SeatLayoutHint'),
    scope: 'world',
    config: true,
    type: String,
    choices: Object.fromEntries(
      SEAT_LAYOUTS.map(layout => [layout, game.i18n.localize(SEAT_LAYOUT_LABELS[layout])]),
    ),
    default: DEFAULT_SEAT_LAYOUT,
    // Riders already aboard move to their new seats rather than waiting for
    // their mount's next step.
    onChange: () => reseatAll(),
  });

  // Registered whatever the system, so `game.settings.get` always resolves and
  // the gate has one code path. Only *shown* on dnd5e — an Animal Handling
  // check is not a meaningful control anywhere else.
  const dnd5e = isDnd5e();

  game.settings.register(MODULE_ID, SETTING_HOSTILE_CHECK, {
    name: game.i18n.localize('S187TM.Settings.HostileCheck'),
    hint: game.i18n.localize('S187TM.Settings.HostileCheckHint'),
    scope: 'world',
    config: dnd5e,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, SETTING_HOSTILE_DC, {
    name: game.i18n.localize('S187TM.Settings.HostileDC'),
    hint: game.i18n.localize('S187TM.Settings.HostileDCHint'),
    scope: 'world',
    config: dnd5e,
    type: Number,
    default: 15,
  });

  game.settings.register(MODULE_ID, SETTING_DEBUG, {
    name: game.i18n.localize('S187TM.Settings.Debug'),
    hint: game.i18n.localize('S187TM.Settings.DebugHint'),
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
  });
}
