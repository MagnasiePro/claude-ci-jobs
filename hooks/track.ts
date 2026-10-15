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
