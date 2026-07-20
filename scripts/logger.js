import { MODULE_ID, SETTING_DEBUG } from './constants.js';

// scorpious187s-lib is optional here so the test server can run this alone.
let cached = null;
function libLogger() {
  return game.modules.get('scorpious187s-lib')?.api?.utils?.makeLogger?.(MODULE_ID) ?? null;
}

function debugEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTING_DEBUG);
  } catch {
    return false;
  }
}

export const log = {
  info: (...a) => (cached ??= libLogger())?.log?.(...a) ?? console.log(`${MODULE_ID} |`, ...a),
  warn: (...a) => console.warn(`${MODULE_ID} |`, ...a),
  error: (...a) => console.error(`${MODULE_ID} |`, ...a),
  debug: (...a) => { if (debugEnabled()) console.log(`${MODULE_ID} | [debug]`, ...a); },
};
