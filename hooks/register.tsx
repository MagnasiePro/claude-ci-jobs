import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type { Job, Pipeline, Repo } from '../types'
import {
  COLOR,
  ICON,
  formatAge,
  formatDuration,
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

const PANE = 'ci-jobs'
const TITLE = 'CI'

const repoAtom = atom({ plugin: 'ci-jobs', key: 'repo' } as const, null)
const branches = atom({ plugin: 'ci-jobs', key: 'branches' } as const, [])
const pipelines = atom({ plugin: 'ci-jobs', key: 'pipelines' } as const, [])
const expanded = atom({ plugin: 'ci-jobs', key: 'expanded' } as const, {})
const busy = atom({ plugin: 'ci-jobs', key: 'busy' } as const, {})
const errorAtom = atom({ plugin: 'ci-jobs', key: 'error' } as const, null)
const updatedAt = atom({ plugin: 'ci-jobs', key: 'updatedAt' } as const, 0)

type Dollar = EngineInterface

const BINARIES: Record<'gh' | 'glab', string[]> = {
  gh: ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'],
  glab: ['glab', '/opt/homebrew/bin/glab', '/usr/local/bin/glab'],
}
const found: Partial<Record<'gh' | 'glab', string>> = {}

/** Runs gh or glab, trying the usual install places when PATH lacks them. */
async function cli($: Dollar, repo: Repo, args: string[]): Promise<ProcessRunResult> {
  const name = repo.provider === 'github' ? 'gh' : 'glab'
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

async function fetchJobs($: Dollar, repo: Repo, pipe: Pipeline): Promise<Job[] | undefined> {
  const ran = await cli($, repo, jobsArgv(repo, pipe.id))
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
      const ran = await cli($, repo, listArgv(repo, branch))
      if (ran.exitCode !== 0) throw new Error(failure(ran))
      next.push(...parsePipelines(repo, ran.stdout, branch))
    } catch (err) {
      errors.push(`${branch}: ${err instanceof Error ? err.message : String(err)}`)
      next.push(...[...before.values()].filter(pipe => pipe.branch === branch))
    }
  }

  const seen = new Set<string>()
  const list = next
    .filter(pipe => (seen.has(pipe.key) ? false : (seen.add(pipe.key), true)))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

  for (const pipe of list) {
    const old = before.get(pipe.key)
    const isStale = !old || old.status !== pipe.status || isActive(pipe.status)
    pipe.jobs = isStale ? undefined : old.jobs
    if (open[pipe.key] !== true || !isStale) continue
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

async function retry($: Dollar, busyKey: string, argv: (repo: Repo) => string[], label: string): Promise<void> {
  const repo = await read($, repoAtom)
  if (!repo) return
  if ((await read($, busy))[busyKey]) return
  await update($, busy, map => ({ ...map, [busyKey]: true }))
  try {
    const ran = await cli($, repo, argv(repo))
    $.ui.toast(ran.exitCode === 0 ? `CI : ${label} relancé` : `CI : échec — ${failure(ran)}`)
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

async function openPane($: Dollar): Promise<void> {
  await $.ui.open({ id: PANE, title: TITLE })
}

export const register: Register = (on, options) => {
  const pollMs = Math.max(5, Number(options.pollSeconds ?? 20)) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ci-jobs',
      description: 'Affiche le panneau CI (pipelines GitHub/GitLab de la session)',
      argumentHint: '[refresh]',
    })
    await detectRepo($)
    await track($, await currentBranch($))
    void openPane($)
    void refresh($)
    $.clock.every(pollMs, () => {
      void (async () => {
        const panes = await $.ui.panes()
        if (panes.some(pane => pane.id === PANE && pane.isShown)) await refresh($)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'ci-jobs' }, async ($, e) => {
    await openPane($)
    if (e.args.trim() === 'refresh') await detectRepo($)
    await refresh($)
    const count = (await read($, pipelines)).length

    return { text: `Panneau CI ouvert (${count} pipeline${count > 1 ? 's' : ''}).` }
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const repo = await read($, repoAtom)
    const list = await read($, pipelines)
    const open = await read($, expanded)
    const running = await read($, busy)
    const error = await read($, errorAtom)
    const tracked = await read($, branches)
    const stamp = await read($, updatedAt)
    const now = Date.now()

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold wrap="truncate">
          {repo ? `${repo.provider === 'github' ? 'GitHub' : 'GitLab'} · ${repo.path}` : 'CI'}
        </Text>
        <Button key="refresh" plain onPress={() => void refresh($)}>
          ⟳ <Text dimColor>{stamp ? formatAge(new Date(stamp).toISOString(), Date.now()) : ''}</Text>
        </Button>
      </Box>
    )

    const rows = list.map(pipe => {
      const isOpen = open[pipe.key] === true
      const failed = pipe.jobs?.some(job => job.status === 'failed') ?? pipe.status === 'failed'

      return (
        <Box key={`b-${pipe.key}`} flexDirection="column">
          <Button key={`p-${pipe.key}`} plain onPress={() => void toggle($, pipe.key)}>
            {isOpen ? '▾ ' : '▸ '}
            <Text color={COLOR[pipe.status]}>{ICON[pipe.status]}</Text>
            {' '}
            {pipe.title}
            {' '}
            <Text dimColor>
              {pipe.branch} · {formatAge(pipe.createdAt, now)}
            </Text>
          </Button>
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2}>
              {!pipe.jobs && <Text dimColor>Chargement des jobs…</Text>}
              {pipe.jobs?.length === 0 && <Text dimColor>Aucun job.</Text>}
              {pipe.jobs?.map(job => (
                <Box key={`j-${pipe.key}-${job.id}`} flexDirection="row" gap={1}>
                  <Text color={COLOR[job.status]}>{ICON[job.status]}</Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate">
                      {job.stage ? <Text dimColor>{job.stage} / </Text> : ''}
                      {job.name}
                    </Text>
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
                        void retry($, `job-${job.id}`, r => retryJobArgv(r, pipe.id, job.id), job.name)
                      }
                    />
                  )}
                </Box>
              ))}
              <Box flexDirection="row" gap={2}>
                {failed && !isActive(pipe.status) && (
                  <Button
                    key={`rf-${pipe.key}`}
                    label={running[`pipe-${pipe.key}`] ? 'Relance…' : 'Relancer les échecs'}
                    onPress={() =>
                      void retry($, `pipe-${pipe.key}`, r => retryFailedArgv(r, pipe.id), `${pipe.title} (échecs)`)
                    }
                  />
                )}
                {pipe.url && <Link href={pipe.url} label="Ouvrir ↗" />}
              </Box>
            </Box>
          )}
        </Box>
      )
    })

    return (
      <Box flexDirection="column" gap={0}>
        {header}
        {tracked.length > 0 && <Text dimColor wrap="truncate">Branches : {tracked.join(', ')}</Text>}
        {error && <Text color="error">{error}</Text>}
        {list.length === 0 && !error && <Text dimColor>Aucune pipeline pour l'instant.</Text>}
        {rows}
      </Box>
    )
  })
}
