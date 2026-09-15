/**
 * Verify that the mount options actually land in the Token Config sheet.
 *
 * Needs jsdom, which is not a dependency of this module:
 *   npm install --no-save jsdom
 * Without it this skips cleanly (exit 0), like tools/verify-v14.mjs.
 *
 * Why this exists
 * ---------------
 * The fieldset is injected into a sheet owned by core, and the markup of that
 * sheet is the one thing that differs between the generations this module
 * supports. The original placement matched a single selector and returned
 * silently when it missed, which is exactly what happened on v13: no fieldset,
 * no error, and no way to mark a token mountable.
 *
 * So the property worth testing is not "does it find the Identity tab" but
 * "does it always end up somewhere usable" — inside the form, out of the tab
 * navigation, with field names that round-trip. These shapes cover the sheet as
 * v14 renders it plus the plausible ways an older or newer one could differ.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const MODULE_ID = 'scorpious187s-token-mounting';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('\nToken Config placement');
  console.log('  jsdom not installed; skipping. Run `npm install --no-save jsdom` to enable.\n');
  process.exit(0);
}

let failures = 0;
const pass = m => console.log(`  ok    ${m}`);
const fail = m => { report(`  FAIL  ${m}`); failures++; };

/* ── Minimal Foundry globals ────────────────────────────────────────────────*/

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.game = {
  i18n: { localize: k => k, format: k => k },
  settings: { get: () => undefined },
  modules: { get: () => undefined },
};

// Some shapes deliberately trigger the module's fallback warning. Capture that
// output rather than letting it reach stderr, where a build would surface it as
// a failure; it is replayed below only if a check actually fails.
const noise = [];
const realError = console.error;
console.warn = (...a) => noise.push(`warn: ${a.join(' ')}`);
console.error = (...a) => noise.push(`error: ${a.join(' ')}`);
const report = m => realError(m);

const handlers = [];
globalThis.Hooks = { on: (name, fn) => handlers.push([name, fn]) };

const { registerTokenConfig } = await import(
  pathToFileURL(path.join(root, 'scripts/token-config.js')).href
);
registerTokenConfig();

const hookNames = handlers.map(([n]) => n);
const handler = handlers.find(([n]) => n === 'renderTokenConfig')?.[1];
if (!handler) {
  fail('renderTokenConfig hook was never registered');
  process.exit(1);
}

/* ── Sheet shapes ───────────────────────────────────────────────────────────*/

// Built in the one document the globals come from. Using a fresh JSDOM per
// shape would put every element in its own realm, which is not how a sheet
// reaches the hook and quietly changes what the unwrap does.
const form = markup => {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host.querySelector('form');
};

// The tab navigation appears in every shape on purpose: injecting into it is
// the specific trap a bare [data-tab="identity"] selector falls into.
const NAV = '<nav class="tabs"><a class="item" data-tab="identity">Identity</a>'
  + '<a class="item" data-tab="appearance">Appearance</a></nav>';
const FOOTER = '<footer class="form-footer"><button type="submit">Save</button></footer>';
const NAME = '<div class="form-group"><input name="name" value="Bre&#225;gh"></div>';

const shapes = {
  'part id + tab + nav (as v14 renders it)':
    `<form>${NAV}<section data-application-part="identity" data-tab="identity">${NAME}</section>${FOOTER}</form>`,
  'part id only':
    `<form>${NAV}<section data-application-part="identity">${NAME}</section>${FOOTER}</form>`,
  'tab only, no part id':
    `<form>${NAV}<section class="tab" data-tab="identity">${NAME}</section>${FOOTER}</form>`,
  'div.tab rather than section':
    `<form>${NAV}<div class="tab" data-tab="identity">${NAME}</div>${FOOTER}</form>`,
  'identity tab renamed':
    `<form>${NAV}<section class="tab" data-tab="core">${NAME}</section>${FOOTER}</form>`,
  'nav link is the only data-tab="identity"':
    `<form>${NAV}<section class="tab" data-tab="basic">${NAME}</section>${FOOTER}</form>`,
  'nothing recognisable, footer present':
    `<form>${NAV.replace('data-tab="identity"', 'data-tab="x"')}<div>${NAME}</div>${FOOTER}</form>`,
  'flat form, no footer':
    `<form>${NAME}</form>`,
};

console.log('\nToken Config placement');
console.log(`  hooks registered: ${hookNames.join(', ')}`);

for (const [label, markup] of Object.entries(shapes)) {
  const sheet = form(markup);
  const app = { token: { getFlag: () => undefined }, setPosition() {} };
  try {
    handler(app, sheet);
  } catch (err) {
    fail(`${label} — threw: ${err.message}`);
    continue;
  }

  const fieldset = sheet.querySelector(`.${MODULE_ID}-config`);
  if (!fieldset) { fail(`${label} — nothing injected`); continue; }
  if (!sheet.contains(fieldset)) { fail(`${label} — outside the form; would not submit`); continue; }
  if (fieldset.closest('nav')) { fail(`${label} — injected into the tab navigation`); continue; }
  if (fieldset.closest('a, button')) { fail(`${label} — injected inside a link or button`); continue; }

  // Every control must carry a real document path or nothing round-trips.
  const names = [...fieldset.querySelectorAll('[name]')].map(e => e.getAttribute('name'));
  const prefixed = names.every(n => n.startsWith(`flags.${MODULE_ID}.`));
  if (names.length !== 5 || !prefixed) {
    fail(`${label} — expected 5 flag-pathed fields, got: ${names.join(', ') || '(none)'}`);
    continue;
  }

  const host = fieldset.parentElement;
  const where = host.tagName === 'FORM'
    ? 'form (fallback)'
    : `${host.tagName.toLowerCase()}.${host.dataset.applicationPart ?? host.dataset.tab ?? host.className}`;
  pass(`${label} → ${where}`);
}

/* ── Which object the flags are read from ───────────────────────────────────*/

console.log('\nDocument resolution');
{
  const withFlags = () => ({ getFlag: () => undefined });
  const cases = {
    'TokenConfig (token + document)': { token: withFlags(), document: withFlags() },
    'PrototypeTokenConfig (token only — ApplicationV2, no document)': { token: withFlags() },
    'legacy shape (object only)': { object: withFlags() },
  };
  for (const [label, partial] of Object.entries(cases)) {
    const sheet = form(shapes['part id + tab + nav (as v14 renders it)']);
    try {
      handler({ ...partial, setPosition() {} }, sheet);
      if (sheet.querySelector(`.${MODULE_ID}-config`)) pass(`${label} → injected`);
      else fail(`${label} → nothing injected`);
    } catch (err) { fail(`${label} — threw: ${err.message}`); }
  }

  // Nothing usable must be a quiet no-op rather than a thrown render.
  const sheet = form(shapes['part id + tab + nav (as v14 renders it)']);
  try {
    handler({ setPosition() {} }, sheet);
    if (sheet.querySelector(`.${MODULE_ID}-config`)) fail('no document → injected anyway');
    else pass('no usable document → skipped quietly');
  } catch (err) { fail(`no document — threw: ${err.message}`); }
}

/* ── How the element arrives ────────────────────────────────────────────────*/

console.log('\nElement unwrapping');
{
  const shape = shapes['part id + tab + nav (as v14 renders it)'];
  const injected = sheet => !!sheet.querySelector(`.${MODULE_ID}-config`);
  const placedInIdentity = sheet => {
    const fs = sheet.querySelector(`.${MODULE_ID}-config`);
    return fs?.parentElement?.dataset?.applicationPart === 'identity';
  };

  // A plain element from this realm.
  {
    const sheet = form(shape);
    handler({ token: { getFlag: () => undefined }, setPosition() {} }, sheet);
    injected(sheet) && placedInIdentity(sheet)
      ? pass('same-realm element → Identity tab')
      : fail('same-realm element → not placed in the Identity tab');
  }

  // A popped-out sheet: same markup, different window, so `instanceof
  // HTMLElement` against this window is false.
  {
    const other = new JSDOM(`<!doctype html><body>${shape}</body>`);
    const sheet = other.window.document.querySelector('form');
    handler({ token: { getFlag: () => undefined }, setPosition() {} }, sheet);
    injected(sheet) && placedInIdentity(sheet)
      ? pass('cross-realm element (popped-out sheet) → Identity tab')
      : fail('cross-realm element → not placed in the Identity tab');
  }

  // A jQuery-style wrapper, which is what older hooks hand over.
  {
    const sheet = form(shape);
    const wrapped = { 0: sheet, length: 1 };
    handler({ token: { getFlag: () => undefined }, setPosition() {} }, wrapped);
    injected(sheet) && placedInIdentity(sheet)
      ? pass('jQuery-wrapped element → Identity tab')
      : fail('jQuery-wrapped element → not placed in the Identity tab');
  }
}

/* ── Re-render ──────────────────────────────────────────────────────────────*/

console.log('\nRe-render');
{
  const sheet = form(shapes['part id + tab + nav (as v14 renders it)']);
  const app = { token: { getFlag: () => undefined }, setPosition() {} };
  handler(app, sheet); handler(app, sheet); handler(app, sheet);
  const n = sheet.querySelectorAll(`.${MODULE_ID}-config`).length;
  if (n === 1) pass('three renders leave exactly one fieldset');
  else fail(`three renders left ${n} fieldsets`);
}

/* ── Against an installed Foundry's own templates ───────────────────────────*/

// Every shape above is hand-written, which makes them a test of my
// reconstruction of the sheet as much as of the selector. This one lifts the
// Identity part's root element verbatim out of an installed Foundry's template
// and adds the `data-application-part` that HandlebarsApplicationMixin stamps on
// it at render time, so strategy 1 is matched against what core actually emits.
// The tab link and name field are rebuilt to match tab-navigation.hbs and what
// {{formGroup}} renders for a text field.
console.log('\nAgainst installed Foundry templates');
{
  const roots = [
    process.env.FOUNDRY_APP,
    'C:/Program Files/Foundry Virtual Tabletop/resources/app',
    '/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app',
  ].filter(Boolean);
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    try {
      for (const entry of fs.readdirSync(`${drive}/`, { withFileTypes: true })) {
        if (entry.isDirectory() && /^FoundryVTT-Node-/i.test(entry.name)) roots.push(`${drive}/${entry.name}`);
      }
    } catch { /* drive absent */ }
  }

  let checked = 0;
  for (const app of [...new Set(roots)]) {
    const template = path.join(app, 'templates/scene/token/identity.hbs');
    if (!fs.existsSync(template)) continue;

    let release = null;
    try { release = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).release; } catch { /* unknown */ }
    const version = release ? `${release.generation}.${release.build}` : 'unknown';

    const resolved = fs.readFileSync(template, 'utf8')
      .replace(/\{\{tab\.id\}\}/g, 'identity')
      .replace(/\{\{tab\.group\}\}/g, 'sheet')
      .replace(/\{\{#if tab\.active\}\}([^{]*)\{\{\/if\}\}/g, '$1')
      .replace(/\{\{[\s\S]*?\}\}/g, '');
    const partOpenTag = resolved.slice(0, resolved.indexOf('>') + 1)
      .replace('<div ', '<div data-application-part="identity" ');

    const sheet = form(
      '<form>'
      + '<nav class="sheet-tabs tabs">'
      + '<a data-action="tab" data-group="sheet" data-tab="identity"><span>Identity</span></a>'
      + '<a data-action="tab" data-group="sheet" data-tab="appearance"><span>Appearance</span></a>'
      + '</nav>'
      + partOpenTag
      + '<div class="form-group"><label>Name</label><div class="form-fields"><input name="name"></div></div>'
      + '</div>'
      + '<footer class="form-footer"><button type="submit">Save</button></footer>'
      + '</form>',
    );

    handler({ token: { getFlag: () => undefined }, setPosition() {} }, sheet);
    const injected = sheet.querySelector(`.${MODULE_ID}-config`);
    const host = injected?.parentElement;

    if (!injected) fail(`Foundry ${version} — nothing injected`);
    else if (injected.closest('nav')) fail(`Foundry ${version} — injected into the tab navigation`);
    else if (host?.dataset?.applicationPart === 'identity') pass(`Foundry ${version} → Identity part`);
    else fail(`Foundry ${version} — landed in <${host?.tagName?.toLowerCase() ?? 'nothing'}> instead of the Identity part`);
    checked++;
  }
  if (!checked) console.log('  no Foundry installation found; skipped.');
}

console.log('');
if (failures) {
  if (noise.length) {
    report('Captured module output:');
    for (const line of noise) report(`  ${line}`);
  }
  report(`${failures} check(s) failed.\n`);
  process.exit(1);
}
console.log(`All Token Config placement checks passed (${noise.length} expected log lines suppressed).\n`);
