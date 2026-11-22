import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { takeShot, type Box, type Browser, type Shot } from './capture.ts';

type Element = { visible?: boolean; box?: Box };

/** A fake browser serving one page: its status, the elements found by role and name or selector, and a log of every call. */
function fakeBrowser(page: { status?: number; scroll?: { x: number; y: number }; closeFails?: boolean; roles?: Record<string, Element>; selectors?: Record<string, Element> } = {}) {
  const log: string[] = [];
  const locator = (key: string, found?: Element): any => ({
    first: () => locator(key, found),
    async waitFor() {
      if (!found?.visible) throw new Error(`Timeout waiting for ${key}`);
      log.push(`visible ${key}`);
    },
    async click() {
      if (!found?.visible) throw new Error(`Timeout waiting for ${key}`);
      log.push(`click ${key}`);
    },
    async boundingBox() {
      return found?.box ?? null;
    },
    key,
  });
  const browser: Browser = {
    async newContext(options) {
      log.push(`context ${JSON.stringify(options)}`);
      return {
        async newPage() {
          return {
            async goto(url) {
              log.push(`goto ${url}`);
              return { status: () => page.status ?? 200 };
            },
            getByRole: (role, { name }) => locator(`${role} "${name}"`, page.roles?.[`${role} "${name}"`]),
            locator: (selector) => locator(selector, page.selectors?.[selector] ?? { visible: true }),
            async evaluate(expression) {
              assert.equal(expression, '({ x: scrollX, y: scrollY })');
              return (page.scroll ?? { x: 0, y: 0 }) as any;
            },
            async screenshot(options) {
              const shot = JSON.stringify({ clip: options.clip, fullPage: options.fullPage, mask: options.mask.map((m: any) => m.key) });
              log.push(`screenshot ${shot}`);
              return Buffer.from(shot);
            },
          };
        },
        async close() {
          log.push('close');
          if (page.closeFails) throw new Error('browser crashed');
        },
      };
    },
  };
  return { browser, log };
}

const out = () => join(mkdtempSync(join(tmpdir(), 'shot-')), 'help/page.png');
const signIn = async () => {};
const options = { baseURL: 'http://localhost:3000', signIn, cropPadding: 16 };

test('a plain shot opens the page in a fresh context at the viewport, masks data-help-mask and writes the image', async () => {
  const { browser, log } = fakeBrowser();
  const shot: Shot = { page: '/absences?org=alder', viewport: 'mobile', as: 'nobody', out: out() };
  await takeShot(browser, shot, options);
  assert.deepEqual(log, [
    'context {"viewport":{"width":390,"height":844},"deviceScaleFactor":2,"colorScheme":"light","reducedMotion":"reduce"}',
    'goto http://localhost:3000/absences?org=alder',
    'screenshot {"mask":["[data-help-mask]"]}',
    'close',
  ]);
  assert.equal(readFileSync(shot.out, 'utf8'), '{"mask":["[data-help-mask]"]}');
});

test('a shot as a person signs in on the fresh context before opening the page', async () => {
  const { browser, log } = fakeBrowser();
  const signIn = async (context: unknown, person: string) => {
    log.push(`signIn ${person} ${typeof (context as any).newPage}`);
  };
  await takeShot(browser, { page: '/', viewport: 'desktop', as: 'Elena Vasquez', out: out() }, { ...options, signIn });
  assert.deepEqual(log.slice(0, 3).map((line) => line.split(' {')[0]), ['context', 'signIn Elena Vasquez function', 'goto http://localhost:3000/']);
  assert.match(log[0], /"width":1280,"height":800/);
});

test('a signed-out shot skips sign-in', async () => {
  for (const as of ['nobody', undefined]) {
    const { browser } = fakeBrowser();
    let called = false;
    const signIn = async () => {
      called = true;
    };
    await takeShot(browser, { page: '/', viewport: 'desktop', as, out: out() }, { ...options, signIn });
    assert.equal(called, false, `as: ${as}`);
  }
});

test('clicks run in order, each waiting for its target, then the wait target must be visible', async () => {
  const roles = { 'button "Menu"': { visible: true }, 'menuitem "Players"': { visible: true }, 'link "Players"': { visible: true } };
  const { browser, log } = fakeBrowser({ roles });
  const shot: Shot = {
    page: '/admin',
    viewport: 'mobile',
    click: [{ role: 'button', name: 'Menu' }, { role: 'menuitem', name: 'Players' }],
    wait: [{ role: 'link', name: 'Players' }],
    out: out(),
  };
  await takeShot(browser, shot, options);
  assert.deepEqual(log.slice(2, -2), [
    'visible button "Menu"',
    'click button "Menu"',
    'visible menuitem "Players"',
    'click menuitem "Players"',
    'visible link "Players"',
  ]);
});

test('a crop shoots the marked region plus padding, in page coordinates, no taller than the cap and never past the page edge', async () => {
  const selectors = {
    '[data-help-crop="tiles"]': { visible: true, box: { x: 100, y: 200, width: 300, height: 400 } },
    '[data-help-crop="nav"]': { visible: true, box: { x: 4, y: 0, width: 200, height: 100 } },
    '[data-help-crop="table"]': { visible: true, box: { x: 0, y: 50, width: 390, height: 2000 } },
  };
  const screenshot = async (crop: string, cropHeight?: number, scroll?: { x: number; y: number }) => {
    const { browser, log } = fakeBrowser({ selectors, scroll });
    await takeShot(browser, { page: '/', viewport: 'mobile', crop, cropHeight, out: out() }, options);
    const { clip, fullPage } = JSON.parse(log.find((line) => line.startsWith('screenshot'))!.slice('screenshot '.length));
    assert.equal(fullPage, true, 'a viewport screenshot would trim the clip to the viewport');
    return clip;
  };
  assert.deepEqual(await screenshot('tiles'), { x: 84, y: 184, width: 332, height: 432 });
  assert.deepEqual(await screenshot('tiles', 300), { x: 84, y: 184, width: 332, height: 300 });
  assert.deepEqual(await screenshot('nav'), { x: 0, y: 0, width: 220, height: 116 });
  // Scrolled down 1500px and across 10px: the clip moves with the page, not the viewport.
  assert.deepEqual(await screenshot('tiles', undefined, { x: 10, y: 1500 }), { x: 94, y: 1684, width: 332, height: 432 });
  // Taller than the 844px mobile viewport, and kept whole.
  assert.deepEqual(await screenshot('table'), { x: 0, y: 34, width: 406, height: 2032 });
});

test('a 404 fails the shot', async () => {
  const { browser, log } = fakeBrowser({ status: 404 });
  await assert.rejects(takeShot(browser, { page: '/gone', viewport: 'desktop', out: out() }, options), /\/gone: the page answered 404/);
  assert.ok(!log.some((line) => line.startsWith('screenshot')));
  assert.equal(log.at(-1), 'close');
});

test('a failure says what was missing and leaves the existing image untouched', async () => {
  const cases: [Partial<Shot>, RegExp][] = [
    [{ click: [{ role: 'button', name: 'Menu' }] }, /\/admin: click target button "Menu" never became visible/],
    [{ wait: [{ role: 'menuitem', name: 'Players' }] }, /\/admin: wait target menuitem "Players" never became visible/],
    [{ crop: 'missing' }, /\/admin: crop region data-help-crop="missing" never became visible/],
  ];
  for (const [lines, message] of cases) {
    const { browser } = fakeBrowser({ selectors: { '[data-help-crop="missing"]': { visible: false } } });
    const shot: Shot = { page: '/admin', viewport: 'desktop', out: out(), ...lines };
    const everything = { visible: true, box: { x: 0, y: 0, width: 10, height: 10 } };
    const working = fakeBrowser({ roles: { 'button "Menu"': everything, 'menuitem "Players"': everything }, selectors: { '[data-help-crop="missing"]': everything } });
    await takeShot(working.browser, shot, options);
    const before = readFileSync(shot.out, 'utf8');
    await assert.rejects(takeShot(browser, shot, options), message);
    assert.equal(readFileSync(shot.out, 'utf8'), before);
  }
});

test('a failed sign-in fails the shot and writes nothing', async () => {
  const { browser } = fakeBrowser();
  const signIn = async () => {
    throw new Error('unknown person Nobody Known');
  };
  const shot: Shot = { page: '/', viewport: 'desktop', as: 'Nobody Known', out: out() };
  await assert.rejects(takeShot(browser, shot, { ...options, signIn }), /unknown person Nobody Known/);
  assert.equal(existsSync(shot.out), false);
});

test('a failed browser close fails the shot and leaves the existing image untouched', async () => {
  const shot: Shot = { page: '/', viewport: 'desktop', out: out() };
  mkdirSync(join(shot.out, '..'), { recursive: true });
  writeFileSync(shot.out, 'old image');
  const { browser } = fakeBrowser({ closeFails: true });
  await assert.rejects(takeShot(browser, shot, options), /browser crashed/);
  assert.equal(readFileSync(shot.out, 'utf8'), 'old image');
});

test('a failed write leaves no temporary file behind', async () => {
  const shot: Shot = { page: '/', viewport: 'desktop', out: out() };
  mkdirSync(shot.out, { recursive: true }); // a folder where the image should go: the rename fails
  await assert.rejects(takeShot(fakeBrowser().browser, shot, options));
  assert.equal(existsSync(`${shot.out}.tmp`), false);
});
