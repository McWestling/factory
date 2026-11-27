// Draws the figures for Factory's public page. Run `node scripts/draw-public-page.ts` from the repo root; it rewrites `public-page/`.
// Every figure is one SVG file that carries its own colours, dark mode and motion, so it works as a plain image.
// The `-live` strips are the same drawing with no items on it, plus what a site's belt script needs to move items along it.
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2] ?? "public-page";
const r1 = (n: number) => +n.toFixed(1);

// Icons from Lucide (ISC licence), in step order.
const names = ["capture", "triage", "refine", "implement", "review", "closeout"];
const lucide = [
  `<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4"/><path d="M2 10h4"/><path d="M2 14h4"/><path d="M2 18h4"/><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>`,
  `<path d="m18 14 4 4-4 4"/><path d="m18 2 4 4-4 4"/><path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22"/><path d="M2 6h1.972a4 4 0 0 1 3.6 2.2"/><path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45"/>`,
  `<path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/>`,
  `<path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/><path d="m18 15 4-4"/><path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>`,
  `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
  `<path d="m16 22-1-4"/><path d="M19 14a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2h-3a1 1 0 0 1-1-1V4a2 2 0 0 0-4 0v5a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2v1a1 1 0 0 0 1 1"/><path d="M19 14H5l-1.973 6.767A1 1 0 0 0 4 22h16a1 1 0 0 0 .973-1.233z"/><path d="m8 22 1-4"/>`,
];
// The steps where a person is brought in to decide.
const lit = [false, true, true, false, true, false];

const css = `.fd{--paper:#f7f2e8;--ink:#17130f;--acc:#8f8372;--on:#17130f;color:var(--ink)}
@media(prefers-color-scheme:dark){.fd{--paper:#171716;--ink:#eee6d6;--acc:#a99f8e}}
.fd text{fill:var(--ink);font-family:Georgia,"Times New Roman",serif;stroke:none}
.fd .n{fill:none}.fd .p{fill:var(--paper)}.fd .i{fill:var(--ink)}.fd .a{fill:var(--acc)}.fd text.on{fill:var(--on)}.fd .s-on{stroke:var(--on)}
.fd .hum{stroke:#e0632a}.fd .hum-t{fill:#e0632a}
.fd .lamp{fill:#e0632a;animation:fd-lamp 2s steps(1,end) infinite}
.fd .rays{stroke:#e0632a;animation:fd-rays 2s steps(1,end) infinite}
@keyframes fd-lamp{0%{fill-opacity:1}50%{fill-opacity:.12}}
@keyframes fd-rays{0%{opacity:1}50%{opacity:0}}
.fd .bub{opacity:0;transform-box:fill-box;transform-origin:50% 100%;animation:fd-bub 12s ease-in-out infinite}
@keyframes fd-bub{0%{opacity:0;transform:translateY(4px) scale(.6)}8%,24%{opacity:1;transform:none}31%,100%{opacity:0;transform:translateY(-4px) scale(.8)}}`;
// Motion for the live strips only. An item enters a gap, stops, and leaves (go), or crosses without stopping (pass).
const liveCss = `
.fd .seal{opacity:0;transition:opacity .3s}
.fd .hop{fill:transparent;stroke:none;cursor:pointer;pointer-events:all}
.fd .go,.fd .pass{opacity:0;animation:fd-go 3.4s ease-in-out 1}
.fd .pass{animation:fd-pass 1.4s ease-in-out 1}
@keyframes fd-go{0%{opacity:var(--i,1);transform:translate(var(--ax),var(--ay))}25%,75%{opacity:1;transform:none}100%{opacity:var(--o,1);transform:translate(var(--bx),var(--by))}}
@keyframes fd-pass{0%{opacity:1;transform:translate(var(--ax),var(--ay))}100%{opacity:var(--o,1);transform:translate(var(--bx),var(--by))}}
.fd .fly{animation:fd-fly .7s ease-in-out 1 backwards}
@keyframes fd-fly{0%{transform:translate(var(--fx),var(--fy))}50%{transform:translate(calc(var(--fx) / 2),calc(var(--fy) - 24px))}100%{transform:none}}
.fd .fly.sink{animation:fd-sink .5s ease-in 1 forwards}
@keyframes fd-sink{to{transform:translateY(30px);opacity:0}}`;

const svg = (w: number, h: number, label: string, body: string, live = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" class="fd" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"${live && ` data-belt='${live}'`}>
<style>${css}${live && liveCss}</style>
<defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" stroke-width="0.8"/></pattern></defs>
<rect class="p" width="${w}" height="${h}" stroke="none"/>
${body}
</svg>
`;

// Station outlines, standing on y=0 and centred on x=0. `k` scales a coordinate.
type K = (n: number) => number;
const shapes: { d: (k: K) => string; corners: number[][]; top: number; lamp: number; icon: number }[] = [
  { d: (k) => `M${k(-26)},${k(-60)} H${k(26)} L${k(14)},0 H${k(-14)} Z`, corners: [[-26, -60], [26, -60], [14, 0]], top: -60, lamp: 4, icon: -37 },
  { d: (k) => `M${k(-24)},0 V${k(-42)} L0,${k(-62)} L${k(24)},${k(-42)} V0 Z`, corners: [[0, -62], [24, -42], [24, 0]], top: -62, lamp: 4, icon: -23 },
  { d: (k) => `M${k(-26)},0 L${k(-14)},${k(-60)} H${k(14)} L${k(26)},0 Z`, corners: [[-14, -60], [14, -60], [26, 0]], top: -60, lamp: 4, icon: -21 },
  { d: (k) => `M${k(-24)},0 V${k(-44)} L${k(24)},${k(-60)} V0 Z`, corners: [[-24, -44], [24, -60], [24, 0]], top: -56, lamp: 8, icon: -23 },
  { d: (k) => `M${k(-22)},0 V${k(-40)} A${k(22)},${k(22)} 0 0 1 ${k(22)},${k(-40)} V0 Z`, corners: [[22, 0]], top: -62, lamp: 0, icon: -25 },
  { d: (k) => `M${k(-26)},0 V${k(-42)} H${k(26)} V0 Z`, corners: [[-26, -42], [26, -42], [26, 0]], top: -42, lamp: 4, icon: -20 },
];
const body = (i: number, s = 1, [dx, dy] = [8, -6]) => {
  const k: K = (n) => r1(n * s);
  const d = shapes[i].d(k);
  return `<path class="p" stroke="none" d="${d}" transform="translate(${dx} ${dy})"/><path fill="url(#hatch)" d="${d}" transform="translate(${dx} ${dy})"/>${shapes[i].corners
    .map(([x, y]) => `<line x1="${k(x)}" y1="${k(y)}" x2="${k(x) + dx}" y2="${k(y) + dy}"/>`)
    .join("")}<path class="p" d="${d}"/>`;
};
const plaque = (i: number, cy: number, r: number, scale: number, width: number) =>
  `<circle class="p" cx="0" cy="${cy}" r="${r}"/><g class="n" stroke-width="${width}" transform="translate(${r1(-12 * scale)} ${r1(cy - 12 * scale)}) scale(${scale})">${lucide[i]}</g>`;
const lamp = (x: number, top: number, on: boolean) =>
  `<line x1="${x}" y1="${top - 3}" x2="${x}" y2="${top - 14}"/><circle class="${on ? "lamp" : "p"}" cx="${x}" cy="${top - 19}" r="4.5"/>${
    on ? `<g class="n rays"><line x1="${x}" y1="${top - 28}" x2="${x}" y2="${top - 33}"/><line x1="${x - 8}" y1="${top - 25}" x2="${x - 12}" y2="${top - 29}"/><line x1="${x + 8}" y1="${top - 25}" x2="${x + 12}" y2="${top - 29}"/></g>` : ""
  }`;
// A point on the timeline, a 45° leader and a numbered circle.
const callout = (x: number, y: number, n: number) =>
  `<circle class="i" cx="${x}" cy="${y}" r="2.5" stroke="none"/><line x1="${x}" y1="${y}" x2="${x + 23.6}" y2="${y + 23.6}" stroke-width="0.8"/><circle class="p" cx="${x + 30}" cy="${y + 30}" r="9" stroke-width="0.8"/><text x="${x + 30}" y="${y + 33.5}" font-size="10.5" text-anchor="middle">${n}</text>`;
const line = (from: number, to: number, y: number) =>
  `<line x1="${from}" y1="${y}" x2="${to - 8}" y2="${y}"/><polygon class="i" points="${to},${y} ${to - 9},${y - 4.5} ${to - 9},${y + 4.5}" stroke="none"/>`;
const at = (x: number, y: number, s: string) => `<g transform="translate(${x} ${y})">${s}</g>`;
const person = (x: number, y: number) => `<path class="p" d="M${x - 14},${y} L${x - 9},${y - 34} H${x + 9} L${x + 14},${y} Z"/><circle class="p" cx="${x}" cy="${y - 46}" r="9"/>`;

// The ways an idea arrives besides a sticky note. Each stands on y=0, centred on x=0, w wide and h tall.
const voice = (w: number, h: number) =>
  `<rect class="p" x="${-w / 2}" y="${-h}" width="${w}" height="${h}" rx="${h / 2}"/><circle class="i" cx="${r1(-w / 2 + h / 2)}" cy="${-h / 2}" r="${r1(h * 0.2)}" stroke="none"/>${[0.5, 0.9, 0.35, 0.7, 1, 0.45, 0.8, 0.3]
    .map((a, n) => {
      const x = r1(-w / 2 + h + (n * (w - h * 1.5)) / 7);
      return `<line x1="${x}" y1="${r1(-h / 2 - a * h * 0.3)}" x2="${x}" y2="${r1(-h / 2 + a * h * 0.3)}"/>`;
    })
    .join("")}`;
const bubble = (w: number, h: number) => {
  const [l, r, b] = [-w / 2, w / 2, r1(-h * 0.22)];
  return `<path class="p" d="M${l + 4},${-h} H${r - 4} Q${r},${-h} ${r},${-h + 4} V${b - 4} Q${r},${b} ${r - 4},${b} H${r1(l + w * 0.34)} L${r1(l + w * 0.16)},0 L${r1(l + w * 0.18)},${b} H${l + 4} Q${l},${b} ${l},${b - 4} V${-h + 4} Q${l},${-h} ${l + 4},${-h} Z"/>`;
};
const mail = (w: number, h: number) => `<rect class="p" x="${-w / 2}" y="${-h}" width="${w}" height="${h}"/><polyline class="n" points="${-w / 2},${-h} 0,${r1(-h * 0.42)} ${w / 2},${-h}"/>`;
const issue = (w: number, h: number) =>
  `<rect class="p" x="${-w / 2}" y="${-h}" width="${w}" height="${h}"/><line x1="${-w / 2}" y1="${r1(-h * 0.64)}" x2="${w / 2}" y2="${r1(-h * 0.64)}"/><circle class="p" cx="${r1(w / 2 - h * 0.18)}" cy="${r1(-h * 0.82)}" r="${r1(h * 0.08)}"/>`;
const tilt = (x: number, y: number, r: number, s: string) => `<g transform="translate(${x} ${y}) rotate(${r})">${s}</g>`;

// ---- Journey strip ----
// What each station hands on: a note, a map (a folded sheet), a stack of smaller tasks, a built block, a checked block, a finished seal.
// Each stands on y=0, centred on x=0.
const sq = `<rect class="a" x="-8" y="-16" width="16" height="16"/>`;
const task = `<path class="a" d="M-11,-13 L-4,-15 L4,-13 L11,-15 V-2 L4,0 L-4,-2 L-11,0 Z"/><path class="n s-on" d="M-4,-15 V-2 M4,-13 V0" stroke-width="0.8"/>`;
const stack = `<rect class="p" x="-11" y="-27" width="15" height="9"/><line x1="-11" y1="-24" x2="4" y2="-24" stroke-width="0.8"/><rect class="p" x="-7.5" y="-18" width="15" height="9"/><line x1="-7.5" y1="-15" x2="7.5" y2="-15" stroke-width="0.8"/><rect class="a" x="-4" y="-9" width="15" height="9"/><line class="s-on" x1="-4" y1="-6" x2="11" y2="-6" stroke-width="0.8"/>`;
const built = `<path class="a" d="M-9,-16 L-4,-21 H12 L7,-16 Z"/><path class="a" d="M7,-16 L12,-21 V-5 L7,0 Z"/><rect class="a" x="-9" y="-16" width="16" height="16"/>`;
const checked = `${built}<polyline class="n s-on" points="-5.5,-8 -2,-4.500 3.5,-12" stroke-width="1.6"/>`;
const seal = `<circle class="a" cx="0" cy="-15" r="15"/><polyline class="n s-on" points="-7,-15 -2,-10 7,-21" stroke-width="2"/>`;
const forms = [sq, task, stack, built, checked, seal];
// The same heap again, tiny, beside the hopper. The belt script flies its notes from the brown one.
const pile = `${tilt(30, 80, -8, mail(22, 15))}${tilt(36, 60, -14, issue(20, 16))}${tilt(56, 44, 9, voice(26, 10))}${tilt(70, 80, 6, bubble(20, 16))}<rect class="a" x="42" y="54" width="20" height="20" transform="rotate(-5 52 64)"/><path class="n" d="M74,46 Q95,46 96,71"/><path class="n" d="M91.500,65 L96,72 L100.500,65"/>`;
const station = (i: number) => `${lamp(shapes[i].lamp, shapes[i].top, lit[i])}${body(i)}${plaque(i, shapes[i].icon, 17, 0.9, 1.6)}${callout(0, 0, i + 1)}`;

const stripLabel = "An idea's journey: a sticky note travels along a timeline through six stations, each marked with its icon on a round plaque, and ends as a finished change. An orange lamp is lit on the second, third and fifth stations, where a person decides.";
// One layout: where the six stations stand, where the still items sit, and the legs a moving item travels.
type Leg = { f: number; x: number; y: number; a: number[]; b: number[]; pass?: 1; i?: 0; o?: 0; end?: 1 };
type Layout = { w: number; h: number; label: string; lines: string; at: number[][]; still: [number, number, number][]; legs: Leg[] };
const B = 140; // a row's timeline
const wide: Layout = {
  w: 824, h: 192, label: stripLabel, lines: line(16, 814, B),
  at: [0, 1, 2, 3, 4, 5].map((i) => [104 + i * 120, B]),
  still: [...[0, 1, 2, 3, 4].map((i): [number, number, number] => [i, 168 + i * 120, B]), [5, 778, B]],
  legs: [...[0, 1, 2, 3, 4].map((i): Leg => ({ f: i, x: 168 + i * 120, y: B, a: [-60, 0], b: [60, 0] })), { f: 5, x: 778, y: B, a: [-74, 0], b: [0, 0], end: 1 }],
};
const rows = [B, B + 180, B + 360];
const tall: Layout = {
  w: 392, h: 552, label: stripLabel + " The timeline is split into three rows of two.", lines: rows.map((y) => line(16, 384, y)).join(""),
  at: [0, 1, 2, 3, 4, 5].map((i) => [104 + (i % 2) * 150, rows[i >> 1]]),
  still: [[0, 183, rows[0]], [1, 40, rows[1]], [2, 183, rows[1]], [3, 40, rows[2]], [4, 183, rows[2]], [5, 336, rows[2]]],
  // An item that reaches the end of a row slides off it and comes in at the start of the next.
  legs: rows.flatMap((y, r): Leg[] => [
    ...(r ? [{ f: r * 2 - 1, x: 254, y: rows[r - 1], a: [0, 0], b: [130, 0], pass: 1, o: 0 } as Leg, { f: r * 2 - 1, x: 40, y, a: [-30, 0], b: [64, 0], i: 0 } as Leg] : []),
    { f: r * 2, x: 183, y, a: [-79, 0], b: [71, 0] },
    ...(r === 2 ? [{ f: 5, x: 336, y, a: [-82, 0], b: [0, 0], end: 1 } as Leg] : []),
  ]),
};
const strip = (L: Layout, live: boolean) => {
  const stations = L.at.map(([x, y], i) => at(x, y, station(i))).join("\n");
  if (!live) return svg(L.w, L.h, L.label, `${L.lines}${pile}\n${stations}\n${L.still.map(([f, x, y]) => at(x, y, forms[f])).join("")}`);
  // Items are drawn on their own layer. The mask hides them wherever a station stands, so they pass behind it.
  const mask = `<mask id="gaps" maskUnits="userSpaceOnUse" x="0" y="0" width="${L.w}" height="${L.h}"><rect width="${L.w}" height="${L.h}" fill="#fff" stroke="none"/>${L.at
    .map(([x, y], i) => `<g transform="translate(${x} ${y})" fill="#000" stroke="#000">${[0, 1, 2, 3, 4].map((n) => `<path d="${shapes[i].d((v) => v)}" transform="translate(${n * 2} ${n * -1.5})"/>`).join("")}</g>`)
    .join("")}</mask>`;
  const [, fx, fy] = L.still[5];
  const data = JSON.stringify({
    legs: L.legs,
    from: [52, 64], // the brown note in the pile
    slots: [[-18, 63, -8], [-6, 60, 6], [6, 64, -4], [16, 61, 10], [-2, 52, 3]].map(([x, y, r]) => [104 + x, y + 8, r]), // where waiting notes poke out of the hopper
  });
  return svg(
    L.w, L.h, L.label,
    `<defs>${mask}${forms.map((f, i) => `<g id="form${i}">${f}</g>`).join("")}</defs>
${L.lines}${pile}
<g class="wait"></g>
${stations}
<g class="belt" mask="url(#gaps)"></g>
<g class="seal">${at(fx, fy, seal)}</g>
<rect class="hop" x="18" y="26" width="124" height="118"/>`,
    data,
  );
};

// ---- Step drawings ----
const S = 1.9; // stations are drawn larger here
const BASE = 240;
const t = (x: number, y: number, s: string, extra = "") => `<text x="${x}" y="${y}" font-size="7"${extra}>${s}</text>`;
const note = (x: number, lines: string[], hand: boolean) =>
  `<rect class="a" x="${x}" y="${BASE - 52}" width="52" height="52"/>${lines.map((l, n) => t(x + 5, BASE - (lines.length > 3 ? 40 : 35) + n * (lines.length > 3 ? 10 : 11), l, ` class="on"${hand ? ' font-style="italic"' : ""}`)).join("")}`;
const card = (x: number, top: number, id: string, lines: string[], brown: boolean) =>
  `<rect class="p" x="${x}" y="${top}" width="70" height="58"/><line x1="${x}" y1="${top + 18}" x2="${x + 70}" y2="${top + 18}"/><circle class="${brown ? "a" : "p"}" cx="${x + 61}" cy="${top + 9}" r="3"${brown ? ' stroke="none"' : ""}/>${t(x + 5, top + 12, id, ' font-weight="bold"')}${lines.map((l, n) => t(x + 5, top + 30 + n * 11, l)).join("")}`;
// A map: a folded sheet with the idea at one end, a flag at the destination, and the way between unknown.
const map = (x: number, top: number, name: string) =>
  `<path class="p" d="M${x},${top + 5} L${x + 25},${top} L${x + 51},${top + 5} L${x + 76},${top} V${top + 59} L${x + 51},${top + 64} L${x + 25},${top + 59} L${x},${top + 64} Z"/><path class="n" d="M${x + 25},${top} V${top + 59} M${x + 51},${top + 5} V${top + 64}" stroke-width="0.5"/>${t(x + 6, top + 18, name, ' font-weight="bold"')}<rect class="a" x="${x + 7}" y="${top + 42}" width="11" height="11" stroke="none"/><path class="n" d="M${x + 21},${top + 47} C${x + 32},${top + 28} ${x + 44},${top + 58} ${x + 61},${top + 43}" stroke-dasharray="2.5 2.5"/><line x1="${x + 63}" y1="${top + 44}" x2="${x + 63}" y2="${top + 26}"/><path class="a" d="M${x + 63},${top + 26} L${x + 72},${top + 29.5} L${x + 63},${top + 33} Z"/><text x="${x + 31}" y="${top + 35}" font-size="9" font-weight="bold">?</text><text x="${x + 47}" y="${top + 59}" font-size="9" font-weight="bold">?</text>`;
const block = (x: number, mark: string) =>
  `<path class="a" d="M${x},${BASE - 44} L${x + 12},${BASE - 54} H${x + 56} L${x + 44},${BASE - 44} Z"/><path class="a" d="M${x + 44},${BASE - 44} L${x + 56},${BASE - 54} V${BASE - 10} L${x + 44},${BASE} Z"/><rect class="a" x="${x}" y="${BASE - 44}" width="44" height="44"/>${mark}`;
const pr = (x: number) => block(x, `<text class="on" x="${x + 22}" y="${BASE - 18}" font-size="11" text-anchor="middle">PR</text>`);
const passed = (x: number) => block(x, `<polyline class="n s-on" points="${x + 10},${BASE - 21} ${x + 19},${BASE - 12} ${x + 34},${BASE - 33}" stroke-width="3"/>`);
// Three bubbles rising above a point: `cx` is its centre, `k` the scale.
const bubbles = (top: number, cx = 160, k = 1.8) =>
  [
    [-32, -24, -9, `<path class="p" d="M-9,-7 H9 Q11,-7 11,-5 V3 Q11,5 9,5 H5 L5,10 L1,5 H-9 Q-11,5 -11,3 V-5 Q-11,-7 -9,-7 Z"/><text class="hum-t" x="0" y="3" font-size="11" font-weight="bold" text-anchor="middle">?</text>`],
    [44, -34, -5, `<path class="p" d="M-9,-7 H9 Q11,-7 11,-5 V3 Q11,5 9,5 H-1 L-5,10 L-4,5 H-9 Q-11,5 -11,3 V-5 Q-11,-7 -9,-7 Z"/><path class="hum n" d="M-6,-4 V1 M-3,-3 V2 M0,-4 V0 M3,-3 V2 M6,-4 V1"/>`],
    [-18, -54, -1, `<ellipse class="p" cx="0" cy="-1" rx="11" ry="7"/><circle class="p" cx="6" cy="9" r="2"/><circle class="p" cx="9" cy="14" r="1.1"/><g class="hum-t" stroke="none"><circle cx="-4" cy="-1" r="1.2"/><circle cx="0" cy="-1" r="1.2"/><circle cx="4" cy="-1" r="1.2"/></g>`],
  ]
    .map(([x, y, delay, shape]) => `<g transform="translate(${r1(cx + (+x * k) / 1.8)} ${r1(top + (+y * k) / 1.8)}) scale(${k})" stroke-width="0.7"><g class="bub" style="animation-delay:${delay}s">${shape}</g></g>`)
    .join("");
const handwritten = ["remind", "people before", "the dinner!!"];

// ---- Where ideas come from ----
// A heap, not a row on a line: these have no order and aren't going anywhere yet.
const mark = (x: number, y: number, cx: number, cy: number, n: number) =>
  `<circle class="i" cx="${x}" cy="${y}" r="2.5" stroke="none"/><line x1="${x}" y1="${y}" x2="${cx}" y2="${cy}" stroke-width="0.8"/><circle class="p" cx="${cx}" cy="${cy}" r="9" stroke-width="0.8"/><text x="${cx}" y="${cy + 3.5}" font-size="10.5" text-anchor="middle">${n}</text>`;
const inputsLabel = "Where ideas come from: a loose heap of five things. A handwritten sticky note that says remind people before the dinner, a voice note, a task typed into the tracker that says RSVP count is wrong, a chat message that asks could guests bring a plus one, and an email.";
const inputs = svg(
  400, 200, inputsLabel,
  `${tilt(128, 158, -12, mail(64, 44))}
${tilt(182, 120, -7, card(-35, -58, "New", ["RSVP count", "is wrong"], false))}
${tilt(236, 92, 10, voice(64, 28))}
${tilt(268, 150, 8, bubble(68, 52) + t(-29, -36, "Could guests") + t(-29, -25, "bring a +1?"))}
${tilt(200, 162, 4, at(-56, -BASE, note(30, handwritten, true)))}
${mark(207, 154, 240, 184, 1)}${mark(252, 72, 288, 46, 2)}${mark(166, 72, 130, 44, 3)}${mark(292, 124, 330, 148, 4)}${mark(108, 142, 72, 168, 5)}`,
);
// The same five as a heap, small, for the start of the Capture drawing. The sticky note goes on top.
const heap5 = `${tilt(102, BASE, 0, mail(34, 24))}${tilt(20, BASE - 18, -8, bubble(34, 28))}${tilt(46, BASE - 46, 5, issue(36, 28))}${tilt(52, BASE - 76, -7, voice(40, 16))}`;

const ask = "Speech, question and thought bubbles rise from the station one at a time, showing that a person decides here.";
const steps: { label: string; into: string; out: string; xs: number[] }[] = [
  {
    label: "Capture: a handwritten sticky note that says remind people before the dinner, on a heap with a voice note, a task, a chat message and an email, is dropped into a station shaped like a hopper, and leaves as a typed note.",
    into: `${heap5}${note(30, handwritten, true)}<path class="n" d="M76,150 C84,112 128,84 139,116"/><path class="n" d="M133,108 L139,117 L145,108"/>`,
    out: note(240, ["Send", "reminders to", "guests before", "dinner events"], false),
    xs: [56, 266],
  },
  {
    label: `Triage: the typed note enters a station with a peaked top and leaves as a folded map named Dinner reminders. On the map, a dashed route with question marks along it runs from the idea to a flag at the destination. ${ask}`,
    into: note(30, ["Send", "reminders to", "guests before", "dinner events"], false),
    out: map(226, BASE - 64, "Dinner reminders"),
    xs: [56, 265],
  },
  {
    label: `Refine: the map named Dinner reminders, its route still marked with question marks, enters a station with a wide base and leaves as two smaller task cards, ABC-104 and ABC-105. ${ask}`,
    into: map(18, BASE - 64, "Dinner reminders"),
    out: card(216, BASE - 98, "ABC-104", ["Host on or off"], false) + card(228, BASE - 58, "ABC-105", ["Email guests", "the day before"], true),
    xs: [57, 263],
  },
  {
    label: "Implement: the small task card ABC-105 enters a station with a sloped roof and leaves as a solid block marked PR, a pull request.",
    into: card(22, BASE - 58, "ABC-105", ["Email guests", "the day before"], true),
    out: pr(240),
    xs: [57, 262],
  },
  {
    label: `Review: the block marked PR enters a domed station and leaves with a tick on it. ${ask}`,
    into: pr(30),
    out: passed(240),
    xs: [52, 262],
  },
  {
    label: "Closeout: the ticked block enters a square station and leaves as a round seal with a tick, the finished change.",
    into: passed(30),
    out: `<circle class="a" cx="264" cy="${BASE - 26}" r="26"/><polyline class="n s-on" points="252,${BASE - 26} 260,${BASE - 18} 277,${BASE - 37}" stroke-width="3"/>`,
    xs: [52, 264],
  },
];
const step = (i: number) => {
  const { label, into, out, xs } = steps[i];
  return svg(
    320, 292, label,
    `${line(14, 306, BASE)}
${at(160, BASE, body(i, S, [12, -9]) + plaque(i, r1(shapes[i].icon * S), 27, 1.75, 1.15))}
${lit[i] ? bubbles(BASE + shapes[i].top * S) : ""}
${into}
${out}
${[xs[0], 160, xs[1]].map((x, n) => callout(x, BASE, n + 1)).join("")}`,
  );
};

// ---- Sorting the work ----
// A work piece standing on y: plain, an open decision ("?") or a settled one ("v").
const pc = (x: number, y: number, k = "") =>
  `<rect class="p" x="${x - 9}" y="${y - 18}" width="18" height="18"/>${k === "?" ? `<text x="${x}" y="${y - 4.5}" font-size="13" font-weight="bold" text-anchor="middle">?</text>` : k === "v" ? `<polyline class="n" points="${x - 4.5},${y - 9} ${x - 1.5},${y - 5.5} ${x + 5},${y - 13}" stroke-width="1.6"/>` : ""}`;
const decide = (x: number, y: number) => `${person(x, y)}${at(x + 30, y, lamp(0, -17, true))}`;
const maker = (x: number, y: number) => at(x, y, lamp(shapes[3].lamp, shapes[3].top, false) + body(3) + plaque(3, shapes[3].icon, 17, 0.9, 1.6));
// The person, head tilted and hand on chin, under a lit lamp, with the bubbles rising above.
const thinker = (x: number, y: number) =>
  `<path class="p" d="M${x - 14},${y} L${x - 9},${y - 34} H${x + 9} L${x + 14},${y} Z"/><circle class="p" cx="${x + 2}" cy="${y - 45}" r="9"/><polyline class="n" points="${x + 10},${y - 29} ${x + 17},${y - 16} ${x + 8},${y - 33}" stroke-width="1.6"/><circle class="p" cx="${x + 7}" cy="${y - 35.5}" r="2.6"/>${at(x + 34, y, lamp(0, -17, true))}${bubbles(y - 56, x, 1.1)}`;
const sortLabel = "Sorting the work: a line of plain squares runs into a station and comes out as built blocks. One square marked with a question mark, a decision, has been lifted off the line to a person, who thinks it over, hand on chin, under a lit orange lamp while speech and thought bubbles rise. A square with a tick, a decision already settled, is back on the line.";
const sorting = svg(
  392, 202, sortLabel,
  `${line(16, 380, 182)}${[34, 60, 112, 138].map((x, n) => pc(x, 182, " ?v "[n].trim())).join("")}
<line x1="86" y1="176" x2="86" y2="132" stroke-dasharray="3 4"/><polyline class="n" points="82,137 86,131 90,137"/>
<line x1="70" y1="120" x2="176" y2="120"/>${pc(86, 120, "?")}${thinker(126, 120)}
${maker(204, 182)}${at(268, 182, built)}${at(302, 182, built)}`,
);

// ---- System map ----
// Brown plates are Factory's own parts; outlined plates are the tools it connects.
const plate = (cx: number, top: number, name: string, role: string, own: boolean) =>
  `<rect fill="url(#hatch)" x="${cx - 44}" y="${top - 6}" width="104" height="44"/><rect class="${own ? "a" : "p"}" x="${cx - 52}" y="${top}" width="104" height="44"/><text${own ? ' class="on"' : ""} x="${cx}" y="${top + 19}" font-size="13" font-weight="bold" text-anchor="middle">${name}</text><text${own ? ' class="on"' : ""} x="${cx}" y="${top + 34}" font-size="10" text-anchor="middle">${role}</text>`;
const arrow = (d: string, [x, y]: number[], dir: "r" | "d" | "l" | "u") => {
  const head = { r: [[-9, -4.5], [-9, 4.5]], l: [[9, -4.5], [9, 4.5]], d: [[-4.5, -9], [4.5, -9]], u: [[-4.5, 9], [4.5, 9]] }[dir];
  return `<path class="n" d="${d}"/><polygon class="i" points="${x},${y} ${head.map(([a, b]) => `${x + a},${y + b}`).join(" ")}" stroke="none"/>`;
};
const parts: [string, string, boolean][] = [
  ["Linear", "holds the tasks", false],
  ["Delegator", "starts the work", true],
  ["Orca", "agents at work", false],
  ["Verifier", "runs the checks", true],
  ["GitHub", "pull request", false],
];
const skills: [string, string, boolean] = ["Skills", "the instructions", true];
const mapLabel = "What Factory is made of: a task in Linear goes to Delegator, which starts coding agents in Orca. The agents follow Factory's skills. Verifier runs the checks, and the change goes up to GitHub as a pull request. A person under a lit orange lamp reviews and merges it, and the result goes back to Linear. Factory's own parts, Skills, Delegator and Verifier, are filled brown.";
const mapWide = svg(
  824, 250, mapLabel,
  `${parts.map(([n, r, own], i) => plate(92 + i * 160, 110, n, r, own)).join("")}
${[0, 1, 2, 3].map((i) => arrow(`M${152 + i * 160},132 H${200 + i * 160}`, [200 + i * 160, 132], "r")).join("")}
${plate(412, 24, ...skills)}${arrow("M412,68 V110", [412, 110], "d")}
${arrow("M732,154 V228 H92 V154", [92, 154], "u")}
${decide(412, 228)}<text x="462" y="218" font-size="10">You decide, review and merge</text>`,
);
const mapTall = svg(
  392, 548, mapLabel,
  `${parts.map(([n, r, own], i) => plate(160, 20 + i * 90, n, r, own)).join("")}
${[0, 1, 2, 3].map((i) => arrow(`M160,${64 + i * 90} V${110 + i * 90}`, [160, 110 + i * 90], "d")).join("")}
${plate(310, 200, ...skills)}${arrow("M258,222 H220", [220, 222], "l")}
${arrow("M160,424 V458", [160, 458], "d")}
${arrow("M210,524 H44 V42 H108", [108, 42], "r")}
${decide(160, 524)}<text x="222" y="504" font-size="10">You decide,</text><text x="222" y="517" font-size="10">review and merge</text>`,
);

// ---- Write ----
mkdirSync(out, { recursive: true });
const files: Record<string, string> = {
  "inputs.svg": inputs,
  "journey-wide.svg": strip(wide, false),
  "journey-tall.svg": strip(tall, false),
  "journey-wide-live.svg": strip(wide, true),
  "journey-tall-live.svg": strip(tall, true),
  "sorting.svg": sorting,
  "map-wide.svg": mapWide,
  "map-tall.svg": mapTall,
};
names.forEach((name, i) => {
  files[`step-${name}.svg`] = step(i);
  files[`icon-${name}.svg`] = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#17130f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><style>@media(prefers-color-scheme:dark){svg{stroke:#eee6d6}}</style>${lucide[i]}</svg>\n`;
});
for (const [name, text] of Object.entries(files)) writeFileSync(`${out}/${name}`, text);
console.log(`Wrote ${Object.keys(files).length} files to ${out}`);
