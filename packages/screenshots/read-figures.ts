import { join } from 'node:path';

export type Viewport = 'desktop' | 'mobile';
export type Target = { role: string; name: string };
export type Shot = {
  page: string;
  as?: string;
  click?: Target[];
  wait?: Target[];
  crop?: string;
  cropHeight?: number;
  viewport: Viewport;
  out: string;
};
export type Defaults = { defaultPerson?: string; imageRoot: string };
export type Skipped = { article: string; line: number };

const VIEWPORTS: readonly Viewport[] = ['desktop', 'mobile'];
const CAPTURE = ['page', 'as', 'click', 'wait', 'crop', 'crop-height'];
const REPEATS = ['click', 'wait'];

type Lines = Map<string, string[]>;

// Reads every :::figure block in one article. Throws on a malformed line, naming the article and line.
export function readFigures(article: string, markdown: string, defaults: Defaults): { shots: Shot[]; skipped: Skipped[] } {
  const lines = markdown.split(/\r?\n/);
  const shots: Shot[] = [];
  const skipped: Skipped[] = [];
  const fail = (n: number, why: string): never => { throw new Error(`${article}:${n}: ${why}`); };

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== ':::figure') continue;
    const start = i + 1;
    const images: Partial<Record<Viewport, string>> = {};
    const shared: Lines = new Map();
    const only: Record<Viewport, Lines> = { desktop: new Map(), mobile: new Map() };
    let hasPage = false;

    for (i++; ; i++) {
      if (i === lines.length) fail(start, 'figure has no closing :::');
      const text = lines[i].trim();
      const n = i + 1;
      if (text === ':::') break;
      if (!text) continue;
      const match = /^(([\w-]+)(?: ([\w-]+))?):\s*(.*)$/.exec(text);
      if (!match) fail(n, `expected "key: value", got "${text}"`);
      const [, label, first, second, value] = match!;
      if (!value) fail(n, `${label}: has no value`);

      if (!second && (first === 'caption' || first === 'alt')) continue;
      if (!second && (first === 'desktop' || first === 'mobile')) {
        if (images[first]) fail(n, `second ${first}: line`);
        images[first] = value;
        continue;
      }
      const scope = second ? VIEWPORTS.find(v => v === first) : undefined;
      const key = second ?? first;
      if ((second && !scope) || !CAPTURE.includes(key)) fail(n, `unknown line "${label}:"`);
      const into = scope ? only[scope] : shared;
      if (into.has(key) && !REPEATS.includes(key)) fail(n, `second ${label}: line`);
      check(key, value, n, fail);
      into.set(key, [...into.get(key) ?? [], value]);
      if (key === 'page') hasPage = true;
    }

    if (!hasPage) { skipped.push({ article, line: start }); continue; }
    const viewports = VIEWPORTS.filter(v => images[v]);
    if (!viewports.length) fail(start, 'figure has page: but no desktop: or mobile: image');
    for (const viewport of viewports) {
      const get = (key: string) => only[viewport].get(key) ?? shared.get(key);
      const page = get('page')?.[0] ?? fail(start, `figure has no page: for its ${viewport} image`);
      const as = get('as')?.[0] ?? defaults.defaultPerson;
      const click = get('click')?.map(target);
      const wait = get('wait')?.map(target);
      const crop = get('crop')?.[0];
      const cropHeight = get('crop-height')?.[0];
      shots.push({
        page,
        ...as && as !== 'nobody' && { as },
        ...click && { click },
        ...wait && { wait },
        ...crop && { crop },
        ...cropHeight && { cropHeight: Number(cropHeight) },
        viewport,
        out: join(defaults.imageRoot, images[viewport]!),
      });
    }
  }
  return { shots, skipped };
}

const TARGET = /^(\S+)\s+"(.+)"$/;

function target(value: string): Target {
  const [, role, name] = TARGET.exec(value)!;
  return { role, name };
}

function check(key: string, value: string, n: number, fail: (n: number, why: string) => never) {
  if ((key === 'click' || key === 'wait') && !TARGET.test(value)) fail(n, `${key}: needs a role and a quoted name, like button "Menu"`);
  if (key === 'crop-height' && !/^[1-9]\d*$/.test(value)) fail(n, 'crop-height: needs a whole number of CSS pixels');
}
