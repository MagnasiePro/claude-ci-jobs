// The pipeline's progress track, drawn the way the plan-progress mod draws a plan:
// a rounded rail, the finished share filled with a soft gradient and twinkling pixels,
// a capsule at each stage boundary, and a coloured pill at the head naming the stage.
import type { Status } from '../types'
import type { Stage } from './providers'

export const TRACK_H = 22
const INK = '#FFFFFF'
const GREY = [132, 130, 138]

/** The plan-progress palette: purple while running, amber waiting on a person, red failed, green done. */
export const STATUS_HEX: Record<Status, string> = {
  running: '#7858CA',
  pending: '#7858CA',
  manual: '#AD6400',
  failed: '#C5353E',
  success: '#18883A',
  canceled: '#84828A',
  skipped: '#84828A',
  unknown: '#84828A',
}

const ICON_PATH: Partial<Record<Status, string>> = {
  success: 'M20 6 9 17l-5-5',
  failed: 'M18 6 6 18M6 6l12 12',
  manual: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
  canceled: 'M5 12h14',
}

const hex = (h: string) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))
const mix = (a: number[], b: number[], m: number) => a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * m))
const rgb = (c: number[]) => `rgb(${c.join(',')})`
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const hash = (a: number, b: number, k: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7 + k * 74.7) * 43758.5453
  return x - Math.floor(x)
}

/** Rough pixel width of a label in the desktop's 12px UI font. */
export const textWidth = (s: string, px = 6.7) =>
  [...s].reduce((w, ch) => w + (/[ilI.,:;'|!]/.test(ch) ? 3.4 : /[mwMW]/.test(ch) ? 9.5 : px), 0)

export type Progress = {
  /** Share of jobs settled, 0..1 (1 only once the pipeline ended). */
  frac: number
  /** 0..99 while unfinished, 100 once ended. */
  percent: number
  /** The stage the pipeline is at: the first not yet passed, else the last. */
  current: Stage | undefined
  /** Stage boundaries as shares of the rail, 0..1. */
  bounds: number[]
}

const PASSED: readonly Status[] = ['success', 'skipped']
const SETTLED: readonly Status[] = ['success', 'failed', 'canceled', 'skipped']

export function progressOf(stages: readonly Stage[], pipelineStatus: Status): Progress {
  const total = stages.reduce((n, stage) => n + stage.jobs.length, 0)
  const settled = stages.reduce((n, stage) => n + stage.done, 0)
  const isOver = SETTLED.includes(pipelineStatus)
  const frac = total === 0 ? (isOver ? 1 : 0) : isOver ? 1 : Math.min(1, settled / total)
  const percent = isOver ? 100 : Math.min(99, Math.floor(frac * 100))
  const current = stages.find(stage => !PASSED.includes(stage.status)) ?? stages.at(-1)
  const bounds: number[] = []
  let acc = 0
  stages.forEach((stage, i) => {
    acc += stage.jobs.length
    if (i < stages.length - 1 && total > 0) bounds.push(acc / total)
  })

  return { frac, percent, current, bounds }
}

/** The rail as an SVG document `W` px wide, for the desktop's `Svg` element. */
export function trackSvg(progress: Progress, status: Status, label: string, W: number): string {
  const H = TRACK_H
  const fx = progress.frac * W
  const color = STATUS_HEX[status]
  const acc = hex(color)
  const light = mix(acc, [255, 255, 255], 0.32)

  // pixels on a 3px grid, denser and warmer towards the head
  const buckets = [0, 1, 2, 3, 4].map(b => {
    const m = b / 4
    const dense = 0.22 + 0.78 * Math.pow(m, 1.5)
    return { color: rgb(mix(GREY, light, m)), opacity: (0.35 + 0.65 * dense).toFixed(2) }
  })
  const dots = new Map<string, string>()
  for (let col = 0; col * 3 < fx; col++) {
    const x = col * 3
    const u = Math.min(1, (x + 1.5) / Math.max(1, fx))
    const dense = 0.22 + 0.78 * Math.pow(u, 1.5)
    const bucket = Math.min(4, Math.floor(Math.min(1, Math.pow(u, 0.9) * 1.1) * 4.99))
    for (let r = 0; r < 7; r++) {
      if (hash(col, r, 1) > dense + 0.1) continue
      const cls = `b${bucket} t${Math.floor(hash(col, r, 2) * 4)}`
      dots.set(cls, `${dots.get(cls) ?? ''}M${x} ${1 + r * 3}h2v2h-2z`)
    }
  }
  const px = [...dots].map(([cls, d]) => `<path class="${cls}" d="${d}"/>`).join('')

  const marks = progress.bounds
    .map(b => {
      const x = b * W
      const passed = x < fx - 1
      const fill = passed ? rgb(mix(light, [255, 255, 255], 0.45)) : '#A8A69E'
      return `<rect x="${(x - 1.5).toFixed(1)}" y="${(H - 10) / 2}" width="3" height="10" rx="1.5" fill="${fill}" opacity="${passed ? 0.95 : 0.75}"/>`
    })
    .join('')

  // the head: a pill carrying the stage name, an icon once it settled
  const icon = ICON_PATH[status]
  const iconW = icon ? 16 : 0
  const maxW = Math.max(80, W * 0.55)
  let shown = label
  while (shown.length > 3 && 20 + iconW + textWidth(shown) > maxW) shown = shown.slice(0, -1)
  if (shown !== label) shown = `${shown.trimEnd()}…`
  const textW = textWidth(shown)
  const kw = Math.round(20 + iconW + textW)
  const left = -(iconW + textW) / 2
  const mid = left + iconW + textW / 2
  const kx = Math.max(kw / 2, Math.min(W - kw / 2, fx))
  const knob =
    `<rect x="${-kw / 2}" y="0" width="${kw}" height="${H}" rx="${H / 2}" fill="${color}"/>` +
    (icon
      ? `<path d="${icon}" transform="translate(${left.toFixed(1)} 5) scale(.5)" fill="none" stroke="${INK}" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : '') +
    `<text x="${mid.toFixed(1)}" y="${H / 2 + 4.2}" text-anchor="middle" class="kt">${esc(shown)}</text>`

  const style = `<style>
${buckets.map((b, i) => `.b${i}{fill:${b.color};fill-opacity:${b.opacity}}`).join('')}
.t0,.t1,.t2,.t3{animation:tw 2.2s ease-in-out infinite}
.t1{animation-duration:2.8s;animation-delay:-.7s}.t2{animation-duration:1.9s;animation-delay:-1.3s}.t3{animation-duration:3.3s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:.45}}
.kt{font:500 12px 'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;fill:${INK}}
@media (prefers-reduced-motion:reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${style}
<defs><clipPath id="pill"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath>
<linearGradient id="base" x1="0" x2="${Math.max(1, fx).toFixed(1)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${rgb(acc)}" stop-opacity=".05"/><stop offset="1" stop-color="${rgb(acc)}" stop-opacity=".33"/></linearGradient></defs>
<g clip-path="url(#pill)"><rect width="${W}" height="${H}" fill="#808080" fill-opacity=".16"/>
<rect width="${fx.toFixed(1)}" height="${H}" fill="url(#base)"/>${px}${marks}</g>
<g transform="translate(${kx.toFixed(1)} 0)">${knob}</g></svg>`
}

/** The terminal's rail: a thin line, heavy over the finished share, light after it. */
export function textTrack(frac: number, cells: number): { done: string; left: string } {
  const n = Math.max(0, Math.min(cells, Math.round(frac * cells)))

  return { done: '━'.repeat(n), left: '─'.repeat(cells - n) }
}
