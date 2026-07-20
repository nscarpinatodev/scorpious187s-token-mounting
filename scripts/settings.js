import {
  MODULE_ID, SETTING_GRANT_OWNERSHIP, SETTING_MAX_RIDERS, SETTING_DEBUG,
} from './constants.js';

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

  game.settings.register(MODULE_ID, SETTING_DEBUG, {
    name: game.i18n.localize('S187TM.Settings.Debug'),
    hint: game.i18n.localize('S187TM.Settings.DebugHint'),
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
  });
}
