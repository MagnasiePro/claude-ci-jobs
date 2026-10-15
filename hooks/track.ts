// The pipeline's progress rail: one segment per stage, fluid width, a light
// sweeping over the stage at work. Loosely after the plan-progress mod's palette.
import type { Status } from '../types'
import type { Stage } from './providers'

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

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

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

export const RAIL_H = 10

/** The share of a stage's jobs that settled, for the running stage's partial fill. */
const stageShare = (stage: Stage) => (stage.jobs.length === 0 ? 0 : stage.done / stage.jobs.length)

/**
 * A fluid rail, `width="100%"` with every coordinate in percent, so it fills
 * whatever box it is given and keeps px-exact rounding and height: one segment
 * per stage (sized by its jobs), filled in its status colour, the running one
 * partly filled with a light sweeping across it, hover titles on each.
 */
export function railSvg(stages: readonly Stage[], status: Status): string {
  const H = RAIL_H
  const total = stages.reduce((n, stage) => n + Math.max(1, stage.jobs.length), 0)
  const GAP = stages.length > 1 ? 0.8 : 0
  const room = 100 - GAP * (stages.length - 1)
  const pct = (n: number) => `${n.toFixed(3)}%`
  const segs: string[] = []
  const clips: string[] = []
  let x = 0

  const list = stages.length > 0 ? stages : [{ name: '', status, jobs: [], done: 0 } as Stage]
  list.forEach((stage, i) => {
    const w = stages.length > 0 ? (Math.max(1, stage.jobs.length) / total) * room : 100
    const color = STATUS_HEX[stage.status]
    const isLive = stage.status === 'running' || stage.status === 'pending'
    const fill = stage.status === 'success' || stage.status === 'failed' || stage.status === 'manual' ? 1 : isLive ? stageShare(stage) : 0
    const title = stage.name ? `<title>${esc(stage.name)} · ${stage.done}/${stage.jobs.length}</title>` : ''
    clips.push(`<clipPath id="c${i}"><rect x="${pct(x)}" y="0" width="${pct(w)}" height="${H}" rx="${H / 2}"/></clipPath>`)
    segs.push(`<g clip-path="url(#c${i})">${title}`)
    segs.push(`<rect x="${pct(x)}" y="0" width="${pct(w)}" height="${H}" class="trk"/>`)
    if (fill > 0) segs.push(`<rect x="${pct(x)}" y="0" width="${pct(w * fill)}" height="${H}" fill="${color}"/>`)
    if (isLive) {
      // a soft light sweeping across the running stage, then a pulse on its tint
      segs.push(`<rect x="${pct(x)}" y="0" width="${pct(w)}" height="${H}" fill="${color}" opacity=".22"><animate attributeName="opacity" values=".12;.34;.12" dur="1.8s" repeatCount="indefinite"/></rect>`)
      segs.push(
        `<rect x="${pct(x - w * 0.4)}" y="0" width="${pct(w * 0.4)}" height="${H}" fill="url(#sweep)"><animate attributeName="x" from="${pct(x - w * 0.4)}" to="${pct(x + w)}" dur="1.6s" repeatCount="indefinite"/></rect>`,
      )
    }
    segs.push('</g>')
    x += w + GAP
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}" preserveAspectRatio="none">
<style>.trk{fill:#808080;fill-opacity:.2}svg{display:block}:root,html,body{background:transparent!important;margin:0;overflow:hidden}</style>
<defs>${clips.join('')}<linearGradient id="sweep" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
${segs.join('')}</svg>`
}

/** The terminal's rail: a heavy line per stage in its colour, light where it is still to run. */
export function textRail(stages: readonly Stage[], cells: number): { text: string; status: Status | 'todo' }[] {
  if (stages.length === 0) return [{ text: '─'.repeat(cells), status: 'todo' }]
  const total = stages.reduce((n, stage) => n + Math.max(1, stage.jobs.length), 0)
  const room = Math.max(stages.length, cells - (stages.length - 1))
  const out: { text: string; status: Status | 'todo' }[] = []
  stages.forEach((stage, i) => {
    const w = Math.max(1, Math.round((Math.max(1, stage.jobs.length) / total) * room))
    const isLive = stage.status === 'running' || stage.status === 'pending'
    const done = stage.status === 'success' || stage.status === 'failed' || stage.status === 'manual' ? w : isLive ? Math.round(w * (stage.done / Math.max(1, stage.jobs.length))) : 0
    if (i > 0) out.push({ text: ' ', status: 'todo' })
    if (done > 0) out.push({ text: '━'.repeat(done), status: stage.status })
    if (w - done > 0) out.push({ text: '─'.repeat(w - done), status: isLive ? stage.status : 'todo' })
  })

  return out
}

export const STEPPER_H = 20

const NODE_ICON: Partial<Record<Status, string>> = {
  success: 'M-3.2 0.2 -1 2.4 3.4-2.2',
  failed: 'M-2.6-2.6 2.6 2.6M2.6-2.6-2.6 2.6',
  canceled: 'M-2.8 0h5.6',
  skipped: 'M-1.4-2.8 1.6 0-1.4 2.8',
  manual: 'M-1.6-2.8 2.6 0-1.6 2.8z',
}

/**
 * The CI pipeline graph, the way GitHub and GitLab draw it in small: one node
 * per stage, evenly spread over the full width, joined by a line that takes
 * the colour of the stages already passed. A settled node carries its icon,
 * the running one spins an arc and breathes a halo, a waiting one is hollow.
 * Nodes sit in nested SVGs placed in percent, so the graph is fluid while each
 * node keeps its pixel size. Hovering a node names the stage.
 */
export function stepperSvg(stages: readonly Stage[], status: Status): string {
  const H = STEPPER_H
  const cy = H / 2
  const R = 7
  const list = stages.length > 0 ? stages : [{ name: '', status, jobs: [], done: 0 } as Stage]
  const n = list.length
  // nodes spread edge to edge, each nudged inwards by up to its radius in px so the
  // end ones stay whole at any width: percent for the place, px for the nudge
  const share = (i: number) => (n === 1 ? 0.5 : i / (n - 1))
  const at = (i: number) => share(i) * 100
  const nudge = (i: number) => (R + 1) * (1 - 2 * share(i))
  const parts: string[] = []

  // links first, under the nodes: each in a frame from one node's place to the next
  for (let i = 0; i < n - 1; i++) {
    const from = list[i]
    const isPassed = from?.status === 'success' || from?.status === 'skipped'
    const color = isPassed ? STATUS_HEX.success : from?.status === 'failed' ? STATUS_HEX.failed : '#808080'
    const opacity = isPassed || from?.status === 'failed' ? 0.9 : 0.35
    const frame = `<svg x="${at(i).toFixed(3)}%" y="0" width="${(at(i + 1) - at(i)).toFixed(3)}%" height="${H}" overflow="visible">`
    const ends = `x1="${nudge(i).toFixed(1)}" y1="${cy}" x2="100%" y2="${cy}"`
    parts.push(`${frame}<line ${ends} stroke="${color}" stroke-opacity="${opacity}" stroke-width="2"/>`)
    if (from?.status === 'running') {
      // work flowing towards the next stage
      parts.push(
        `<line ${ends} stroke="${STATUS_HEX.running}" stroke-width="2" stroke-dasharray="4 6"><animate attributeName="stroke-dashoffset" from="20" to="0" dur=".9s" repeatCount="indefinite"/></line>`,
      )
    }
    parts.push('</svg>')
  }

  list.forEach((stage, i) => {
    const color = STATUS_HEX[stage.status]
    const title = stage.name ? `<title>${esc(stage.name)} · ${stage.done}/${stage.jobs.length} · ${stage.status}</title>` : ''
    let node = ''
    if (stage.status === 'running') {
      node =
        `<circle r="${R + 2}" fill="${color}" opacity=".25"><animate attributeName="r" values="${R};${R + 4};${R}" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values=".35;0;.35" dur="1.6s" repeatCount="indefinite"/></circle>` +
        `<circle r="${R}" class="bg" stroke="${color}" stroke-width="2"/>` +
        `<path d="M0-${R - 3.5}A${R - 3.5} ${R - 3.5} 0 0 1 ${R - 3.5} 0" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s" repeatCount="indefinite"/></path>`
    } else if (stage.status === 'pending' || stage.status === 'unknown') {
      node = `<circle r="${R - 1}" class="bg" stroke="#808080" stroke-opacity=".7" stroke-width="2"/>`
    } else {
      const icon = NODE_ICON[stage.status]
      node =
        `<circle r="${R}" fill="${color}"/>` +
        (icon ? `<path d="${icon}" fill="${stage.status === 'manual' ? '#fff' : 'none'}" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` : '')
    }
    parts.push(`<svg x="${at(i).toFixed(3)}%" y="0" width="1" height="${H}" overflow="visible"><g transform="translate(${nudge(i).toFixed(1)} ${cy})">${title}${node}</g></svg>`)
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}" overflow="visible">
<style>svg{display:block;overflow:visible}:root,html,body{background:transparent!important;margin:0;overflow:hidden;color-scheme:light dark}.bg{fill:#fff}@media (prefers-color-scheme:dark){.bg{fill:#1F1E1D}}</style>
${parts.join('')}</svg>`
}

const TEXT_NODE: Record<Status, string> = {
  success: '●',
  failed: '✕',
  running: '◉',
  pending: '○',
  manual: '▶',
  canceled: '⊘',
  skipped: '◌',
  unknown: '○',
}

/** The terminal's graph: `●━━━━◉────○`, nodes in their colour, passed links heavy. */
export function textStepper(stages: readonly Stage[], cells: number): { text: string; status: Status | 'todo' }[] {
  const list = stages.length > 0 ? stages : []
  if (list.length === 0) return [{ text: '○', status: 'todo' }]
  const n = list.length
  const link = n > 1 ? Math.max(1, Math.floor((cells - n) / (n - 1))) : 0
  const out: { text: string; status: Status | 'todo' }[] = []
  list.forEach((stage, i) => {
    out.push({ text: TEXT_NODE[stage.status], status: stage.status === 'pending' ? 'todo' : stage.status })
    if (i < n - 1) {
      const isPassed = stage.status === 'success' || stage.status === 'skipped'
      out.push(isPassed ? { text: '━'.repeat(link), status: 'success' } : stage.status === 'failed' ? { text: '━'.repeat(link), status: 'failed' } : { text: '─'.repeat(link), status: 'todo' })
    }
  })

  return out
}
