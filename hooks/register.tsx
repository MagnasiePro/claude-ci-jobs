import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type { Job, Pipeline, Repo } from '../types'
import { BACKEND_LABEL, detectServers, glabArgv, localCall, mcpData, officialCall } from './gitlab'
import type { BackendKind, GitlabOp, GitlabServers } from './gitlab'
import {
  COLOR,
  ICON,
  formatAge,
  formatDuration,
  latestPerBranch,
  progressSegments,
  stagesOf,
  glJobs,
  glPipelines,
  isActive,
  jobsArgv,
  listArgv,
  parseJobs,
  parsePipelines,
  parseRemote,
  pushedBranch,
  retryFailedArgv,
  retryJobArgv,
} from './providers'


const repoAtom = atom({ plugin: 'ci-jobs', key: 'repo' } as const, null)
const branches = atom({ plugin: 'ci-jobs', key: 'branches' } as const, [])
const pipelines = atom({ plugin: 'ci-jobs', key: 'pipelines' } as const, [])
const expanded = atom({ plugin: 'ci-jobs', key: 'expanded' } as const, {})
const busy = atom({ plugin: 'ci-jobs', key: 'busy' } as const, {})
const errorAtom = atom({ plugin: 'ci-jobs', key: 'error' } as const, null)
const updatedAt = atom({ plugin: 'ci-jobs', key: 'updatedAt' } as const, 0)
const via = atom({ plugin: 'ci-jobs', key: 'via' } as const, null)

type Dollar = EngineInterface

const BINARIES: Record<'gh' | 'glab', string[]> = {
  gh: ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
  glab: ['glab', '/opt/homebrew/bin/glab', '/usr/local/bin/glab'],
}
const found: Partial<Record<'gh' | 'glab', string>> = {}

/** Runs gh or glab, trying the usual install places when PATH lacks them. */
async function cli($: Dollar, name: 'gh' | 'glab', args: string[]): Promise<ProcessRunResult> {
  const known = found[name]
  const tries = known ? [known] : BINARIES[name]
  let last: unknown
  for (const bin of tries) {
    try {
      const ran = await $.process.run([bin, ...args], { timeoutMs: 30_000 })
      found[name] = bin

      return ran
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error(`${name} introuvable`)
}

function failure(ran: ProcessRunResult): string {
  return (ran.stderr || ran.stdout).trim().split('\n').slice(-2).join(' ') || `exit ${ran.exitCode}`
}

const SKIP_MS = 5 * 60_000
const skipUntil = new Map<string, number>()
const projectIds = new Map<string, string>()
const activated = new Set<string>()

/** Runs a GitLab op down the chain: official MCP, local MCP, then glab. */
async function runGitlab(
  $: Dollar,
  servers: GitlabServers,
  repo: Repo,
  op: GitlabOp,
): Promise<{ data: unknown; backend: BackendKind }> {
  const errors: string[] = []
  const isRead = op.op === 'list' || op.op === 'jobs'
  const isSkipped = (key: string) => isRead && (skipUntil.get(`${key}|${repo.host}/${repo.path}`) ?? 0) > Date.now()
  const failed = (kind: BackendKind, key: string, err: unknown) => {
    errors.push(`${BACKEND_LABEL[kind]}: ${err instanceof Error ? err.message : String(err)}`)
    if (isRead) skipUntil.set(`${key}|${repo.host}/${repo.path}`, Date.now() + SKIP_MS)
  }

  const official = officialCall(repo, op)
  for (const server of official ? servers.official : []) {
    if (!official || isSkipped(server)) continue
    try {
      return { data: mcpData(await $.mcp.call(server, official.tool, official.args)), backend: 'mcp-official' }
    } catch (err) {
      failed('mcp-official', server, err)
    }
  }
  for (const server of servers.local) {
    if (isSkipped(server)) continue
    try {
      const call = localCall(await localProjectId($, server, repo), op)

      return { data: mcpData(await $.mcp.call(server, call.tool, call.args)), backend: 'mcp-local' }
    } catch (err) {
      failed('mcp-local', server, err)
    }
  }
  if (!isSkipped('glab')) {
    try {
      const ran = await cli($, 'glab', glabArgv(repo, op))
      if (ran.exitCode !== 0) throw new Error(failure(ran))

      return { data: JSON.parse(ran.stdout || 'null'), backend: 'glab' }
    } catch (err) {
      failed('glab', 'glab', err)
    }
  }
  throw new Error(errors.length > 0 ? errors.join(' | ') : 'aucun backend GitLab disponible')
}

/**
 * The project's numeric id on a local server (some allow-list projects by id
 * only), found among the projects the user belongs to.
 */
async function localProjectId($: Dollar, server: string, repo: Repo): Promise<string> {
  const cacheKey = `${server}|${repo.path}`
  const cached = projectIds.get(cacheKey)
  if (cached) return cached
  if (!activated.has(server)) {
    activated.add(server)
    try {
      await $.mcp.call(server, 'discover_tools', { category: 'pipelines' })
    } catch {
      // servers without opt-in toolsets expose the pipeline tools already
    }
  }
  const name = repo.path.split('/').pop() ?? repo.path
  const data = mcpData(
    await $.mcp.call(server, 'list_projects', { search: name, membership: true, simple: true, per_page: 100 }),
  )
  const list = Array.isArray(data) ? (data as Record<string, unknown>[]) : []
  const hit = list.find(project => project.path_with_namespace === repo.path)
  if (!hit || hit.id === undefined) throw new Error(`projet ${repo.path} introuvable`)
  const id = String(hit.id)
  projectIds.set(cacheKey, id)

  return id
}

async function git($: Dollar, args: string[]): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['git', ...args], { timeoutMs: 10_000 })

    return ran.exitCode === 0 ? ran.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

async function currentBranch($: Dollar): Promise<string | undefined> {
  const head = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])

  return head && head !== 'HEAD' ? head : undefined
}

async function track($: Dollar, branch: string | undefined): Promise<void> {
  if (!branch) return
  await update($, branches, list => (list.includes(branch) ? list : [branch, ...list]))
}

async function detectRepo($: Dollar): Promise<Repo | null> {
  const url = await git($, ['remote', 'get-url', 'origin'])
  const repo = url ? parseRemote(url) ?? null : null
  await update($, repoAtom, () => repo)

  return repo
}

let servers: GitlabServers = { official: [], local: [] }

/** Runs a GitLab op down the chain and notes which backend answered. */
async function viaGitlab($: Dollar, repo: Repo, op: GitlabOp): Promise<unknown> {
  const { data, backend } = await runGitlab($, servers, repo, op)
  const label = BACKEND_LABEL[backend]
  if ((await read($, via)) !== label) await update($, via, () => label)

  return data
}

async function listPipelines($: Dollar, repo: Repo, branch: string): Promise<Pipeline[]> {
  if (repo.provider === 'gitlab') return glPipelines(await viaGitlab($, repo, { op: 'list', branch, perPage: 5 }), branch)
  const ran = await cli($, 'gh', listArgv(repo, branch))
  if (ran.exitCode !== 0) throw new Error(failure(ran))
  if ((await read($, via)) !== 'gh') await update($, via, () => 'gh')

  return parsePipelines(repo, ran.stdout, branch)
}

async function fetchJobs($: Dollar, repo: Repo, pipe: Pipeline): Promise<Job[] | undefined> {
  if (repo.provider === 'gitlab') return glJobs(await viaGitlab($, repo, { op: 'jobs', pipelineId: pipe.id }))
  const ran = await cli($, 'gh', jobsArgv(repo, pipe.id))
  if (ran.exitCode !== 0) throw new Error(failure(ran))

  return parseJobs(repo, ran.stdout)
}

let refreshing: Promise<void> | undefined

/** Re-reads every tracked branch's pipelines, and the jobs of open or running ones. */
function refresh($: Dollar): Promise<void> {
  refreshing ??= doRefresh($).finally(() => {
    refreshing = undefined
  })

  return refreshing
}

async function doRefresh($: Dollar): Promise<void> {
  const repo = (await read($, repoAtom)) ?? (await detectRepo($))
  if (!repo) {
    await update($, errorAtom, () => 'Pas de remote git « origin » GitHub/GitLab dans ce dossier.')
    return
  }
  await track($, await currentBranch($))
  const tracked = await read($, branches)
  const open = await read($, expanded)
  const before = new Map((await read($, pipelines)).map(pipe => [pipe.key, pipe]))
  const errors: string[] = []
  const next: Pipeline[] = []

  for (const branch of tracked) {
    try {
      next.push(...(await listPipelines($, repo, branch)))
    } catch (err) {
      errors.push(`${branch}: ${err instanceof Error ? err.message : String(err)}`)
      next.push(...[...before.values()].filter(pipe => pipe.branch === branch))
    }
  }

  const seen = new Set<string>()
  const list = next
    .filter(pipe => (seen.has(pipe.key) ? false : (seen.add(pipe.key), true)))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

  const shown = new Set(latestPerBranch(list).map(pipe => pipe.key))
  for (const pipe of list) {
    const old = before.get(pipe.key)
    const isStale = !old || old.status !== pipe.status || isActive(pipe.status)
    pipe.jobs = isStale ? undefined : old.jobs
    if (!isStale || (!shown.has(pipe.key) && open[pipe.key] !== true)) continue
    try {
      pipe.jobs = await fetchJobs($, repo, pipe)
    } catch (err) {
      errors.push(`${pipe.title}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await update($, pipelines, () => list)
  await update($, errorAtom, () => (errors.length > 0 ? errors.join('\n') : null))
  await update($, updatedAt, () => Date.now())
}

async function toggle($: Dollar, key: string): Promise<void> {
  const state = await update($, expanded, map => ({ ...map, [key]: !map[key] }))
  if (!state[key]) return
  const repo = await read($, repoAtom)
  const pipe = (await read($, pipelines)).find(one => one.key === key)
  if (!repo || !pipe || pipe.jobs) return
  try {
    const jobs = await fetchJobs($, repo, pipe)
    await update($, pipelines, list => list.map(one => (one.key === key ? { ...one, jobs } : one)))
  } catch (err) {
    $.ui.toast(`CI : ${err instanceof Error ? err.message : String(err)}`)
  }
}

type RetryOp = Extract<GitlabOp, { op: 'retryJob' | 'retryFailed' }>

async function retry($: Dollar, busyKey: string, op: RetryOp, label: string): Promise<void> {
  const repo = await read($, repoAtom)
  if (!repo) return
  if ((await read($, busy))[busyKey]) return
  await update($, busy, map => ({ ...map, [busyKey]: true }))
  try {
    if (repo.provider === 'gitlab') {
      await viaGitlab($, repo, op)
      $.ui.toast(`CI : ${label} relancé`)
    } else {
      const argv = op.op === 'retryJob' ? retryJobArgv(repo, op.pipelineId, op.jobId) : retryFailedArgv(repo, op.pipelineId)
      const ran = await cli($, 'gh', argv)
      $.ui.toast(ran.exitCode === 0 ? `CI : ${label} relancé` : `CI : échec — ${failure(ran)}`)
    }
  } catch (err) {
    $.ui.toast(`CI : échec — ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    await update($, busy, map => {
      const { [busyKey]: _, ...rest } = map
      return rest
    })
  }
  await refresh($)
  $.clock.after(5_000, () => void refresh($))
}

const names = (value: unknown, fallback: string): string[] =>
  String(value ?? fallback)
    .split(',')
    .map(name => name.trim())
    .filter(Boolean)

export const register: Register = (on, options) => {
  const pollMs = Math.max(5, Number(options.pollSeconds ?? 20)) * 1000
  const configured: GitlabServers = {
    official: names(options.gitlabMcpOfficial, 'plugin:gitlab:gitlab'),
    local: names(options.gitlabMcpLocal, 'gitlab-forge'),
  }
  servers = configured

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci-jobs',
      description: 'Rafraîchit la bande CI (pipelines GitHub/GitLab de la session)',
      argumentHint: '[refresh]',
    })
    try {
      servers = detectServers(configured, (await $.tool.list()).map(tool => tool.name))
    } catch {
      servers = configured
    }
    await detectRepo($)
    await track($, await currentBranch($))
    // v0.2 drew in a side pane; the band above the prompt replaces it
    void $.ui.close({ id: 'ci-jobs' }).catch(() => undefined)
    void refresh($)
    let tick = 0
    $.clock.every(pollMs, () => {
      tick += 1
      void (async () => {
        const isBusy = (await read($, pipelines)).some(pipe => isActive(pipe.status))
        if (isBusy || tick % 4 === 0) await refresh($)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'ci-jobs' }, async ($, e) => {
    if (e.args.trim() === 'refresh') await detectRepo($)
    await refresh($)
    const count = latestPerBranch(await read($, pipelines)).length

    return { text: `CI : ${count} pipeline${count > 1 ? 's' : ''} suivie${count > 1 ? 's' : ''}, au-dessus du prompt.` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const push = pushedBranch(e.command)
    if (push.isPush && !ran.isError && !ran.deny) {
      await track($, push.branch ?? (await currentBranch($)))
      $.clock.after(2_000, () => void refresh($))
      $.clock.after(10_000, () => void refresh($))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const repo = await read($, repoAtom)
    const list = latestPerBranch(await read($, pipelines))
    const error = await read($, errorAtom)
    if (!repo || (list.length === 0 && !error)) return next(e)

    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const open = await read($, expanded)
    const running = await read($, busy)
    const backend = await read($, via)
    const now = Date.now()
    const cols = e.props.bodyColumns
    const barWidth = Math.max(8, Math.min(28, Math.floor(cols / 4)))

    const rows = list.slice(0, 5).map(pipe => {
      const isOpen = open[pipe.key] === true
      const stages = stagesOf(pipe.jobs ?? [])
      const current = stages.find(stage => stage.status !== 'success' && stage.status !== 'skipped') ?? stages.at(-1)
      const doneStages = stages.filter(stage => stage.status === 'success' || stage.status === 'skipped').length
      const failed = stages.some(stage => stage.status === 'failed') || pipe.status === 'failed'
      const onToggle = () => void toggle($, pipe.key)

      const bar = stages.length > 0 ? (
        progressSegments(stages, barWidth).map((segment, i) => (
          <Text key={`seg-${pipe.key}-${i}`} color={COLOR[segment.status]}>
            {i > 0 ? ' ' : ''}
            {segment.text}
          </Text>
        ))
      ) : (
        <Text dimColor>{'░'.repeat(barWidth)}</Text>
      )

      return (
        <Box key={`b-${pipe.key}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key={`p-${pipe.key}`} plain onPress={onToggle}>
              <Text dimColor>{isOpen ? '▾' : '▸'}</Text> <Text color={COLOR[pipe.status]}>{ICON[pipe.status]}</Text>
            </Button>
            <Box flexShrink={0}>{bar}</Box>
            <Box flexGrow={1} flexShrink={1}>
              <Button key={`t-${pipe.key}`} plain onPress={onToggle}>
                <Text wrap="truncate">
                  {current ? (
                    <Text color={COLOR[current.status]}>
                      {current.name} {doneStages}/{stages.length}
                    </Text>
                  ) : (
                    <Text dimColor>…</Text>
                  )}
                  <Text dimColor>
                    {' · '}
                    {pipe.branch} · {pipe.title} · {formatAge(pipe.createdAt, now)}
                  </Text>
                </Text>
              </Button>
            </Box>
          </Box>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={4} marginBottom={1}>
              {!pipe.jobs && <Text dimColor>Chargement des jobs…</Text>}
              {stages.map((stage, i) => (
                <Box key={`s-${pipe.key}-${stage.name}`} flexDirection="column">
                  <Text>
                    <Text color={COLOR[stage.status]}>{ICON[stage.status]}</Text>{' '}
                    <Text bold>{stage.name}</Text>
                    <Text dimColor>
                      {' '}
                      {stage.done}/{stage.jobs.length}
                    </Text>
                  </Text>
                  {stage.jobs.map(job => (
                    <Box key={`j-${pipe.key}-${job.id}`} flexDirection="row" gap={1}>
                      <Text dimColor>{i < stages.length - 1 ? '│' : ' '}</Text>
                      <Text color={COLOR[job.status]}>{ICON[job.status]}</Text>
                      <Box flexGrow={1} flexShrink={1}>
                        <Text wrap="truncate">{job.name}</Text>
                      </Box>
                      <Text dimColor>{formatDuration(job.durationSec)}</Text>
                      {running[`job-${job.id}`] ? (
                        <Text dimColor>…</Text>
                      ) : (
                        <Button
                          key={`r-${pipe.key}-${job.id}`}
                          label="↻"
                          plain
                          onPress={() =>
                            void retry($, `job-${job.id}`, { op: 'retryJob', pipelineId: pipe.id, jobId: job.id }, job.name)
                          }
                        />
                      )}
                    </Box>
                  ))}
                </Box>
              ))}
              <Box flexDirection="row" gap={2}>
                {failed && !isActive(pipe.status) && (
                  <Button
                    key={`rf-${pipe.key}`}
                    plain
                    onPress={() =>
                      void retry($, `pipe-${pipe.key}`, { op: 'retryFailed', pipelineId: pipe.id }, `${pipe.title} (échecs)`)
                    }
                  >
                    <Text color="suggestion">{running[`pipe-${pipe.key}`] ? 'Relance…' : '↻ Relancer les échecs'}</Text>
                  </Button>
                )}
                {pipe.url && <Link href={pipe.url} label="Ouvrir ↗" />}
                <Text dimColor>{backend ? `via ${backend}` : ''}</Text>
              </Box>
            </Box>
          )}
        </Box>
      )
    })

    return (
      <Box flexDirection="column">
        {error && (
          <Text color="error" wrap="truncate">
            CI : {error}
          </Text>
        )}
        {rows}
      </Box>
    )
  })
}
