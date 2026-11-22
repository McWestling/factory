// The capture core: takes one screenshot of one page in one state. It knows nothing about Help articles or the
// generator's config file. The caller hands it a Playwright browser; the interfaces below name only the Playwright
// calls used, so Factory needs no Playwright dependency.
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A role and accessible name, matched as Playwright's getByRole matches them. */
export type Target = { role: string; name: string };

/** One image to take, from one figure's capture lines. */
export type Shot = {
  page: string;
  as?: string;
  click?: Target[];
  wait?: Target[];
  crop?: string;
  cropHeight?: number;
  viewport: 'desktop' | 'mobile';
  out: string;
};

export type Box = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

export interface Locator {
  first(): Locator;
  click(): Promise<void>;
  waitFor(options: { state: 'visible' }): Promise<void>;
  scrollIntoViewIfNeeded(): Promise<void>;
  boundingBox(): Promise<Box | null>;
}

export interface Page {
  goto(url: string): Promise<{ status(): number } | null>;
  getByRole(role: string, options: { name: string }): Locator;
  locator(selector: string): Locator;
  evaluate<R>(expression: string): Promise<R>;
  // any: the caller's own Playwright Locator, which this file can't name. Locator[] would reject Playwright's Page.
  screenshot(options: { clip?: Box; fullPage?: boolean; mask: any[] }): Promise<Uint8Array>;
}

export interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export interface Browser {
  newContext(options: { viewport: Size; deviceScaleFactor: number; colorScheme: 'light'; reducedMotion: 'reduce' }): Promise<Context>;
}

export interface ShotOptions {
  baseURL: string;
  signIn(context: Context, person: string): Promise<void>;
  cropPadding: number;
  viewports?: Record<Shot['viewport'], Size>;
}

export const VIEWPORTS: Record<Shot['viewport'], Size> = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } };

/** Takes the shot and writes it to shot.out. On failure it throws and leaves any image already at shot.out untouched. */
export async function takeShot(browser: Browser, shot: Shot, options: ShotOptions): Promise<void> {
  const viewport = (options.viewports ?? VIEWPORTS)[shot.viewport];
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  let image: Uint8Array;
  try {
    if (shot.as && shot.as !== 'nobody') await options.signIn(context, shot.as);
    const page = await context.newPage();
    const status = (await page.goto(new URL(shot.page, options.baseURL).href))?.status() ?? 200;
    if (status >= 400) throw new Error(`${shot.page}: the page answered ${status}`);
    for (const target of shot.click ?? []) await (await visible(page.getByRole(target.role, { name: target.name }), `click target ${describe(target)}`, shot)).click();
    for (const target of shot.wait ?? []) await visible(page.getByRole(target.role, { name: target.name }), `wait target ${describe(target)}`, shot);
    const clip = shot.crop === undefined ? undefined : await cropBox(page, shot, options.cropPadding);
    // A crop is in page coordinates, so it can reach below the fold; without one, the shot is the viewport.
    image = await page.screenshot({ ...clip && { clip, fullPage: true }, mask: [page.locator('[data-help-mask]')] });
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  // Closed before writing, so a failed close can't leave a new image behind a thrown error.
  await context.close();
  mkdirSync(dirname(shot.out), { recursive: true });
  const tmp = `${shot.out}.tmp`;
  try {
    writeFileSync(tmp, image);
    renameSync(tmp, shot.out);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

const describe = (target: Target) => `${target.role} "${target.name}"`;

/** The first match, once visible; otherwise an error naming what was missing. */
async function visible(locator: Locator, what: string, shot: Shot): Promise<Locator> {
  const first = locator.first();
  try {
    await first.waitFor({ state: 'visible' });
  } catch (error) {
    throw new Error(`${shot.page}: ${what} never became visible`, { cause: error });
  }
  return first;
}

/** The crop region's box plus padding, in page coordinates, kept on the page and no taller than cropHeight. */
async function cropBox(page: Page, shot: Shot, padding: number): Promise<Box> {
  const region = await visible(page.locator(`[data-help-crop="${shot.crop}"]`), `crop region data-help-crop="${shot.crop}"`, shot);
  // A full-page shot doesn't scroll a panel inside the page, so bring the region into view first.
  await region.scrollIntoViewIfNeeded();
  const box = await region.boundingBox();
  if (!box) throw new Error(`${shot.page}: crop region data-help-crop="${shot.crop}" has no box`);
  // boundingBox() is relative to the viewport; the full-page clip wants page coordinates.
  const scroll = await page.evaluate<{ x: number; y: number }>('({ x: scrollX, y: scrollY })');
  const left = box.x + scroll.x;
  const top = box.y + scroll.y;
  const x = Math.max(0, left - padding);
  const y = Math.max(0, top - padding);
  const height = top + box.height + padding - y;
  return { x, y, width: left + box.width + padding - x, height: Math.min(height, shot.cropHeight ?? height) };
}
