import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFigures, type Defaults } from './read-figures.ts';

const defaults: Defaults = { defaultPerson: 'member', imageRoot: 'public' };

const figure = (...lines: string[]) => [
  '# An article', '', ':::figure',
  'caption: A caption.',
  'alt: Alt text',
  'desktop: /help-assets/a/shot-desktop.png',
  'mobile: /help-assets/a/shot-mobile.png',
  ...lines, ':::', '',
].join('\n');

test('a plain page shot gives one whole-viewport shot per image', () => {
  assert.deepEqual(readFigures('a.md', figure('page: /absences'), defaults), {
    shots: [
      { page: '/absences', as: 'member', viewport: 'desktop', out: 'public/help-assets/a/shot-desktop.png' },
      { page: '/absences', as: 'member', viewport: 'mobile', out: 'public/help-assets/a/shot-mobile.png' },
    ],
    skipped: [],
  });
});

test('click lines are kept in order and wait lines become targets', () => {
  const { shots } = readFigures('a.md', figure(
    'page: /absences', 'click: button "Report attendance issue for"', 'click: menuitem "I\'ll be late"', 'wait: dialog "Late"',
  ), defaults);
  assert.deepEqual(shots[0].click, [
    { role: 'button', name: 'Report attendance issue for' },
    { role: 'menuitem', name: "I'll be late" },
  ]);
  assert.deepEqual(shots[0].wait, [{ role: 'dialog', name: 'Late' }]);
});

test('a cropped shot carries its region and height', () => {
  const { shots } = readFigures('a.md', figure('page: /', 'crop: home-module-tiles', 'crop-height: 480'), defaults);
  assert.equal(shots[1].crop, 'home-module-tiles');
  assert.equal(shots[1].cropHeight, 480);
});

test('a desktop or mobile prefix applies to that image and replaces the shared lines of its kind', () => {
  const { shots } = readFigures('a.md', figure(
    'page: /admin', 'crop: admin-sidebar-nav', 'click: button "Expand"', 'click: button "More"',
    'mobile click: button "Menu"', 'mobile crop: admin-mobile-menu', 'desktop as: admin',
  ), defaults);
  assert.deepEqual(shots, [
    { page: '/admin', as: 'admin', click: [{ role: 'button', name: 'Expand' }, { role: 'button', name: 'More' }],
      crop: 'admin-sidebar-nav', viewport: 'desktop', out: 'public/help-assets/a/shot-desktop.png' },
    { page: '/admin', as: 'member', click: [{ role: 'button', name: 'Menu' }],
      crop: 'admin-mobile-menu', viewport: 'mobile', out: 'public/help-assets/a/shot-mobile.png' },
  ]);
});

test('a figure with no page: yields no shots and is reported as skipped', () => {
  assert.deepEqual(readFigures('dues.md', figure(), defaults), { shots: [], skipped: [{ article: 'dues.md', line: 3 }] });
});

test('as: names the person, falls back to the default, and nobody or no default is signed out', () => {
  const as = (lines: string[], d = defaults) => readFigures('a.md', figure('page: /', ...lines), d).shots[0].as;
  assert.equal(as(['as: section-leader']), 'section-leader');
  assert.equal(as([]), 'member');
  assert.equal(as([], { imageRoot: 'public' }), undefined);
  assert.equal(as(['as: nobody']), undefined);
});

for (const [line, error] of [
  ['page /absences', /^Error: a\.md:9: expected "key: value"/],
  ['zoom: 2', /^Error: a\.md:9: unknown line "zoom:"/],
  ['tablet crop: x', /^Error: a\.md:9: unknown line "tablet crop:"/],
  ['click: Menu', /^Error: a\.md:9: click: needs a role and a quoted name/],
  ['crop-height: tall', /^Error: a\.md:9: crop-height: needs a whole number/],
  ['page: /other', /^Error: a\.md:9: second page: line/],
  ['crop:', /^Error: a\.md:9: crop: has no value/],
] as const) {
  test(`a malformed line is an error naming the article and line: ${line}`, () => {
    assert.throws(() => readFigures('a.md', figure('page: /', line), defaults), error);
  });
}

test('a figure with no closing ::: is an error at its opening line', () => {
  assert.throws(() => readFigures('a.md', '\n:::figure\npage: /\n', defaults), /^Error: a\.md:2: figure has no closing :::/);
});

test('the prototype example article parses to the shots it describes', () => {
  const article = `# Absences

:::figure
caption: Select the status icon next to the event.
alt: Absences event row status menu
desktop: /help-assets/absences/report-late-or-absent-for-an-event-absence-status-menu-desktop.png
mobile: /help-assets/absences/report-late-or-absent-for-an-event-absence-status-menu-mobile.png
page: /absences
click: button "Report attendance issue for"
wait: menuitem "I'll be late"
crop: absence-event-row
:::

:::figure
caption: Absences lists your upcoming rehearsals and concerts.
alt: Absences page
desktop: /help-assets/absences/absences-page-desktop.png
mobile: /help-assets/absences/absences-page-mobile.png
page: /absences
:::

:::figure
caption: Home shows a tile for each thing you can do.
alt: Home tiles
desktop: /help-assets/home/home-tiles-desktop.png
mobile: /help-assets/home/home-tiles-mobile.png
page: /
as: section-leader
crop: home-module-tiles
crop-height: 480
:::

:::figure
caption: The admin sidebar lists every section.
alt: Admin sidebar navigation
desktop: /help-assets/admin/admin-sidebar-desktop.png
mobile: /help-assets/admin/admin-sidebar-mobile.png
page: /admin
as: admin
wait: link "Players"
crop: admin-sidebar-nav
crop-height: 360
mobile click: button "Menu, admin navigation"
mobile wait: menuitem "Players"
mobile crop: admin-mobile-menu
:::

:::figure
caption: How dues flow from member to treasurer.
alt: Dues flow diagram
desktop: /help-assets/dues/flow-desktop.png
mobile: /help-assets/dues/flow-mobile.png
:::
`;
  const menu = { click: [{ role: 'button', name: 'Report attendance issue for' }], wait: [{ role: 'menuitem', name: "I'll be late" }], crop: 'absence-event-row' };
  assert.deepEqual(readFigures('absences.md', article, defaults), {
    shots: [
      { page: '/absences', as: 'member', ...menu, viewport: 'desktop', out: 'public/help-assets/absences/report-late-or-absent-for-an-event-absence-status-menu-desktop.png' },
      { page: '/absences', as: 'member', ...menu, viewport: 'mobile', out: 'public/help-assets/absences/report-late-or-absent-for-an-event-absence-status-menu-mobile.png' },
      { page: '/absences', as: 'member', viewport: 'desktop', out: 'public/help-assets/absences/absences-page-desktop.png' },
      { page: '/absences', as: 'member', viewport: 'mobile', out: 'public/help-assets/absences/absences-page-mobile.png' },
      { page: '/', as: 'section-leader', crop: 'home-module-tiles', cropHeight: 480, viewport: 'desktop', out: 'public/help-assets/home/home-tiles-desktop.png' },
      { page: '/', as: 'section-leader', crop: 'home-module-tiles', cropHeight: 480, viewport: 'mobile', out: 'public/help-assets/home/home-tiles-mobile.png' },
      { page: '/admin', as: 'admin', wait: [{ role: 'link', name: 'Players' }], crop: 'admin-sidebar-nav', cropHeight: 360,
        viewport: 'desktop', out: 'public/help-assets/admin/admin-sidebar-desktop.png' },
      { page: '/admin', as: 'admin', click: [{ role: 'button', name: 'Menu, admin navigation' }], wait: [{ role: 'menuitem', name: 'Players' }],
        crop: 'admin-mobile-menu', cropHeight: 360, viewport: 'mobile', out: 'public/help-assets/admin/admin-sidebar-mobile.png' },
    ],
    skipped: [{ article: 'absences.md', line: 48 }],
  });
});
