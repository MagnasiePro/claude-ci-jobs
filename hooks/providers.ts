import type { Job, Pipeline, Repo, Status } from '../types'

const RUN_LIMIT = 5

/** Reads a git remote URL (ssh, scp-like or https) into the repository it names. */
export function parseRemote(url: string): Repo | undefined {
  const raw = url.trim()
  let host: string | undefined
  let path: string | undefined
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(raw)
  if (scp && !/^[a-z]+:\/\//i.test(raw)) {
    host = scp[1]
    path = scp[2]
  } else {
    const web = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(raw)
    if (web) {
      host = web[1]
      path = web[2]
    }
  }
  if (!host || !path) return undefined
  path = path.replace(/\.git$/, '').replace(/\/+$/, '')
  if (!path.includes('/')) return undefined
  const provider = host === 'github.com' || host.includes('github') ? 'github' : 'gitlab'

  return { provider, host, path }
}

/**
 * Says whether a shell command pushes a branch (or opens a PR / MR for one),
 * and which branch when the command names it.
 */
export function pushedBranch(command: string): { isPush: boolean; branch?: string } {
  const parts = command.split(/&&|\|\||;|\|/)
  for (const part of parts) {
    const words = part.trim().split(/\s+/)
    const at = words.findIndex((word, i) => word === 'git' && words[i + 1] === 'push')
    if (at >= 0) {
      const rest = words.slice(at + 2)
      if (rest.some(word => ['--delete', '-d', '--tags', '--mirror'].includes(word))) continue
      const positional = rest.filter(word => !word.startsWith('-'))
      const spec = positional[1]
      if (!spec) return { isPush: true }
      const dst = (spec.includes(':') ? spec.split(':')[1] : spec)?.replace(/^\+/, '')
      const branch = dst?.replace(/^refs\/heads\//, '')
      if (!branch || branch === 'HEAD' || branch.startsWith('refs/')) return { isPush: true }

      return { isPush: true, branch }
    }
    if (/\bgh\s+pr\s+create\b/.test(part) || /\bglab\s+mr\s+create\b/.test(part)) {
      return { isPush: true }
    }
  }

  return { isPush: false }
}

function ghRepo(repo: Repo): string {
  return repo.host === 'github.com' ? repo.path : `${repo.host}/${repo.path}`
}

function glabProject(repo: Repo): string {
  return `projects/${encodeURIComponent(repo.path)}`
}

/** The argv listing a branch's latest pipelines (without the binary). */
export function listArgv(repo: Repo, branch: string): string[] {
  if (repo.provider === 'github') {
    return [
      'run', 'list', '-R', ghRepo(repo), '--branch', branch, '--limit', String(RUN_LIMIT),
      '--json', 'databaseId,displayTitle,workflowName,status,conclusion,headBranch,createdAt,url,event',
    ]
  }

  return [
    'api', '--hostname', repo.host,
    `${glabProject(repo)}/pipelines?ref=${encodeURIComponent(branch)}&per_page=${RUN_LIMIT}`,
  ]
}

/** The argv listing one pipeline's jobs. */
export function jobsArgv(repo: Repo, pipelineId: string): string[] {
  if (repo.provider === 'github') {
    return ['run', 'view', pipelineId, '-R', ghRepo(repo), '--json', 'jobs']
  }

  return ['api', '--hostname', repo.host, `${glabProject(repo)}/pipelines/${pipelineId}/jobs?per_page=100`]
}

/** The argv retrying one job. */
export function retryJobArgv(repo: Repo, pipelineId: string, jobId: string): string[] {
  if (repo.provider === 'github') {
    return ['run', 'rerun', pipelineId, '--job', jobId, '-R', ghRepo(repo)]
  }

  return ['api', '--hostname', repo.host, '-X', 'POST', `${glabProject(repo)}/jobs/${jobId}/retry`]
}

/** The argv retrying every failed job of a pipeline. */
export function retryFailedArgv(repo: Repo, pipelineId: string): string[] {
  if (repo.provider === 'github') {
    return ['run', 'rerun', pipelineId, '--failed', '-R', ghRepo(repo)]
  }

  return ['api', '--hostname', repo.host, '-X', 'POST', `${glabProject(repo)}/pipelines/${pipelineId}/retry`]
}

export function ghStatus(status: string, conclusion: string | null | undefined): Status {
  if (status === 'completed') {
    switch (conclusion) {
      case 'success': return 'success'
      case 'failure':
      case 'timed_out':
      case 'startup_failure': return 'failed'
      case 'cancelled': return 'canceled'
      case 'skipped':
      case 'neutral': return 'skipped'
      case 'action_required': return 'manual'
      default: return 'unknown'
    }
  }
  if (status === 'in_progress') return 'running'
  if (['queued', 'waiting', 'pending', 'requested'].includes(status)) return 'pending'

  return 'unknown'
}

export function glStatus(status: string): Status {
  switch (status) {
    case 'success': return 'success'
    case 'failed': return 'failed'
    case 'running': return 'running'
    case 'created':
    case 'pending':
    case 'preparing':
    case 'scheduled':
    case 'waiting_for_resource':
    case 'waiting_for_callback': return 'pending'
    case 'canceled':
    case 'canceling': return 'canceled'
    case 'skipped': return 'skipped'
    case 'manual': return 'manual'
    default: return 'unknown'
  }
}

type GhRun = {
  databaseId: number
  displayTitle?: string
  workflowName?: string
  status: string
  conclusion?: string | null
  headBranch?: string
  createdAt?: string
  url?: string
}

/** Turns `listArgv`'s output into pipelines. Throws on unreadable output. */
export function parsePipelines(repo: Repo, stdout: string, branch: string): Pipeline[] {
  const data: unknown = JSON.parse(stdout || '[]')
  if (repo.provider === 'github') {
    if (!Array.isArray(data)) throw new Error(errorText(data) ?? 'unexpected answer')

    return (data as GhRun[]).map(run => ({
      key: `github-${run.databaseId}`,
      id: String(run.databaseId),
      branch: run.headBranch ?? branch,
      title: [run.workflowName, run.displayTitle].filter(Boolean).join(' · ') || `#${run.databaseId}`,
      status: ghStatus(run.status, run.conclusion),
      url: run.url,
      createdAt: run.createdAt,
    }))
  }

  return glPipelines(data, branch)
}

type GhJob = {
  databaseId: number
  name: string
  status: string
  conclusion?: string | null
  startedAt?: string
  completedAt?: string
  url?: string
}

function seconds(from?: string, to?: string): number | undefined {
  if (!from || !to || to.startsWith('0001')) return undefined
  const ms = Date.parse(to) - Date.parse(from)

  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : undefined
}

/** Turns `jobsArgv`'s output into jobs. Throws on unreadable output. */
export function parseJobs(repo: Repo, stdout: string): Job[] {
  const data: unknown = JSON.parse(stdout || '[]')
  if (repo.provider === 'github') {
    const jobs = (data as { jobs?: GhJob[] }).jobs
    if (!Array.isArray(jobs)) throw new Error(errorText(data) ?? 'unexpected answer')

    return jobs.map(job => ({
      id: String(job.databaseId),
      name: job.name,
      status: ghStatus(job.status, job.conclusion),
      durationSec: seconds(job.startedAt, job.completedAt),
      url: job.url,
    }))
  }

  return glJobs(data)
}

type Rec = Record<string, unknown>

const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined

/** `123`, `"123"` or a GraphQL global id (`gid://gitlab/Ci::Pipeline/123`) to `"123"`. */
const plainId = (value: unknown): string => str(value)?.replace(/^gid:\/\/.*\//, '') ?? ''

/**
 * The list a GitLab answer carries: a REST array, or a GraphQL-ish object
 * (`{ pipelines: { nodes } }`, `{ jobs: [...] }`, `{ nodes }`, `{ data: ... }`).
 */
export function glList(data: unknown, keys: readonly string[]): Rec[] {
  if (Array.isArray(data)) return data as Rec[]
  if (!data || typeof data !== 'object') throw new Error('unexpected answer')
  const obj = data as Rec
  if (Array.isArray(obj.nodes)) return obj.nodes as Rec[]
  for (const key of [...keys, 'data', 'project', 'pipeline']) {
    if (key in obj && obj[key] !== null && typeof obj[key] === 'object') {
      try {
        return glList(obj[key], keys)
      } catch {
        // try the next key
      }
    }
  }
  throw new Error(errorText(data) ?? 'unexpected answer')
}

/** GitLab pipelines from any answer shape (REST via glab or MCP, GraphQL-ish via MCP). */
export function glPipelines(data: unknown, branch: string): Pipeline[] {
  return glList(data, ['pipelines']).map(pipe => {
    const id = plainId(pipe.iid !== undefined && pipe.id === undefined ? pipe.iid : pipe.id)
    const source = str(pipe.source)?.toLowerCase()

    return {
      key: `gitlab-${id}`,
      id,
      branch: str(pipe.ref) ?? branch,
      title: `#${id}${source ? ` · ${source}` : ''}`,
      status: glStatus(str(pipe.status)?.toLowerCase() ?? ''),
      url: str(pipe.web_url) ?? str(pipe.webUrl),
      createdAt: str(pipe.created_at) ?? str(pipe.createdAt),
    }
  })
}

/** GitLab jobs from any answer shape, oldest stage first. */
export function glJobs(data: unknown): Job[] {
  const list = glList(data, ['jobs']).map(job => {
    const stage = job.stage && typeof job.stage === 'object' ? str((job.stage as Rec).name) : str(job.stage)
    const duration = typeof job.duration === 'number' ? Math.round(job.duration) : undefined

    return {
      id: plainId(job.id),
      name: str(job.name) ?? '?',
      stage,
      status: glStatus(str(job.status)?.toLowerCase() ?? ''),
      durationSec: duration,
      url: str(job.web_url) ?? str(job.webUrl),
    }
  })
  const isNewestFirst = list.length > 1 && Number(list[0]?.id) > Number(list[list.length - 1]?.id)

  return isNewestFirst ? list.reverse() : list
}

function errorText(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'message' in data) return String((data as { message: unknown }).message)

  return undefined
}

export const ICON: Record<Status, string> = {
  success: '✓',
  failed: '✗',
  running: '●',
  pending: '○',
  canceled: '⊘',
  skipped: '⊘',
  manual: '▶',
  unknown: '?',
}

export const COLOR: Record<Status, 'success' | 'error' | 'warning' | 'subtle' | 'suggestion' | 'inactive'> = {
  success: 'success',
  failed: 'error',
  running: 'warning',
  pending: 'suggestion',
  canceled: 'inactive',
  skipped: 'inactive',
  manual: 'subtle',
  unknown: 'subtle',
}

export function isActive(status: Status): boolean {
  return status === 'running' || status === 'pending'
}

export function formatDuration(sec?: number): string {
  if (sec === undefined) return ''
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)

  return m < 60 ? `${m}m${String(sec % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export function formatAge(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(sec)) return ''
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`

  return `${Math.floor(sec / 86400)}j`
}

export type Stage = { name: string; status: Status; jobs: Job[]; done: number }

const SETTLED: readonly Status[] = ['success', 'failed', 'canceled', 'skipped']

/** The status of a group of jobs: a failure wins, then work in flight, then what is left. */
export function rollup(statuses: readonly Status[]): Status {
  if (statuses.length === 0) return 'unknown'
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('running')) return 'running'
  if (statuses.some(status => status === 'pending')) {
    return statuses.some(status => SETTLED.includes(status)) ? 'running' : 'pending'
  }
  if (statuses.includes('manual')) return 'manual'
  if (statuses.every(status => status === 'canceled')) return 'canceled'
  if (statuses.every(status => status === 'skipped')) return 'skipped'

  return statuses.includes('canceled') ? 'canceled' : 'success'
}

/** Jobs grouped by stage in run order (a GitHub job is its own stage). */
export function stagesOf(jobs: readonly Job[]): Stage[] {
  const order: string[] = []
  const groups = new Map<string, Job[]>()
  for (const job of jobs) {
    const name = job.stage ?? job.name
    if (!groups.has(name)) {
      groups.set(name, [])
      order.push(name)
    }
    groups.get(name)?.push(job)
  }

  return order.map(name => {
    const list = groups.get(name) ?? []

    return {
      name,
      jobs: list,
      status: rollup(list.map(job => job.status)),
      done: list.filter(job => SETTLED.includes(job.status)).length,
    }
  })
}

export const BAR_GLYPH: Record<Status, string> = {
  success: '█',
  failed: '█',
  running: '▓',
  pending: '░',
  canceled: '░',
  skipped: '░',
  manual: '▒',
  unknown: '░',
}

/**
 * A stepped progress bar: one segment per stage, `width` cells in all, one
 * blank between segments; each segment is its stage's glyph and colour.
 */
export function progressSegments(stages: readonly Stage[], width: number): { text: string; status: Status }[] {
  if (stages.length === 0) return []
  const room = Math.max(stages.length, width - (stages.length - 1))
  const base = Math.floor(room / stages.length)
  let extra = room - base * stages.length

  return stages.map(stage => {
    const cells = Math.max(1, base + (extra-- > 0 ? 1 : 0))

    return { text: BAR_GLYPH[stage.status].repeat(cells), status: stage.status }
  })
}

/** The latest pipeline of each branch, in the order the list holds them. */
export function latestPerBranch(list: readonly Pipeline[]): Pipeline[] {
  const seen = new Set<string>()

  return list.filter(pipe => (seen.has(pipe.branch) ? false : (seen.add(pipe.branch), true)))
}
