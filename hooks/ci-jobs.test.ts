import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

import { parseJobs, parsePipelines, parseRemote, pushedBranch, retryJobArgv } from './providers'

const GH = { provider: 'github', host: 'github.com', path: 'acme/app' } as const
const GL = { provider: 'gitlab', host: 'gitlab.example.com', path: 'grp/sub/app' } as const

const ok = (stdout: string): ProcessRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const RUNS = JSON.stringify([
  {
    databaseId: 42,
    displayTitle: 'feat: thing',
    workflowName: 'CI',
    status: 'completed',
    conclusion: 'failure',
    headBranch: 'feat/x',
    createdAt: '2026-10-15T10:00:00Z',
    url: 'https://github.com/acme/app/actions/runs/42',
  },
])
const JOBS = JSON.stringify({
  jobs: [
    {
      databaseId: 7,
      name: 'lint',
      status: 'completed',
      conclusion: 'failure',
      startedAt: '2026-10-15T10:00:00Z',
      completedAt: '2026-10-15T10:01:30Z',
      url: 'u',
    },
  ],
})

/** A fake host: git answers a GitHub remote on main, gh answers RUNS / JOBS; every argv is recorded. */
function host(on: On, calls: string[][]): void {
  mock.clock(on)
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    const [bin, ...args] = argv
    if (bin === 'git' && args[0] === 'remote') return { value: ok('git@github.com:acme/app.git\n') }
    if (bin === 'git' && args[0] === 'rev-parse') return { value: ok('main\n') }
    if (args[0] === 'run' && args[1] === 'list') return { value: ok(RUNS) }
    if (args[0] === 'run' && args[1] === 'view') return { value: ok(JOBS) }
    if (args[0] === 'run' && args[1] === 'rerun') return { value: ok('') }

    return { value: { ...ok(''), exitCode: 1, stderr: `unexpected ${argv.join(' ')}` } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
}

const PANE = {
  component: 'Pane',
  requestId: 'ci-jobs',
  props: { title: 'CI', isFocused: false, bodyColumns: 60 } as never,
} as const

describe('providers', () => {
  test('reads remotes', () => {
    expect(parseRemote('git@github.com:acme/app.git')).toEqual(GH)
    expect(parseRemote('https://gitlab.example.com/grp/sub/app.git')).toEqual(GL)
    expect(parseRemote('ssh://git@gitlab.example.com:2222/grp/sub/app.git')).toEqual(GL)
    expect(parseRemote('nonsense')).toBeUndefined()
  })

  test('spots pushes', () => {
    expect(pushedBranch('git push -u origin feat/x')).toEqual({ isPush: true, branch: 'feat/x' })
    expect(pushedBranch('git add . && git commit -m x && git push')).toEqual({ isPush: true })
    expect(pushedBranch('git push origin HEAD:refs/heads/fix')).toEqual({ isPush: true, branch: 'fix' })
    expect(pushedBranch('gh pr create --fill')).toEqual({ isPush: true })
    expect(pushedBranch('git push origin --delete old').isPush).toBe(false)
    expect(pushedBranch('git status').isPush).toBe(false)
  })

  test('parses GitHub and GitLab answers', () => {
    const [run] = parsePipelines(GH, RUNS, 'feat/x')
    expect(run).toMatchObject({ key: 'github-42', status: 'failed', title: 'CI · feat: thing' })
    expect(parseJobs(GH, JOBS)).toEqual([{ id: '7', name: 'lint', status: 'failed', durationSec: 90, url: 'u' }])
    const [pipe] = parsePipelines(GL, JSON.stringify([{ id: 9, ref: 'main', status: 'running', source: 'push' }]), 'main')
    expect(pipe).toMatchObject({ key: 'gitlab-9', status: 'running', title: '#9 · push' })
    const jobs = parseJobs(GL, JSON.stringify([{ id: 2, name: 'b', stage: 'test', status: 'pending' }, { id: 1, name: 'a', stage: 'build', status: 'success', duration: 12.4 }]))
    expect(jobs.map(job => job.name)).toEqual(['a', 'b'])
    expect(retryJobArgv(GL, '9', '2')).toEqual(['api', '--hostname', 'gitlab.example.com', '-X', 'POST', 'projects/grp%2Fsub%2Fapp/jobs/2/retry'])
  })
})

describe('pane', () => {
  test('tracks a pushed branch', async ($, on) => {
    const calls: string[][] = []
    host(on, calls)
    on('tool.call', () => ({ result: {} as never, text: 'pushed' }))
    await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/x' })
    const ui = await $.ui.mount({ plugin: 'ci-jobs', surface: 'desktop', ...PANE })
    expect((await ui.find({ type: 'Text', text: /Branches/ }))?.text).toContain('feat/x')
    await ui.unmount()
  })

  test('folds, unfolds and retries on every surface', async ($, on) => {
    const calls: string[][] = []
    host(on, calls)
    await $.command.run({
      command: 'ci-jobs',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'ci-jobs',
        surface,
        ...PANE,
      })
      expect(await ui.find({ key: 'p-github-42' })).toBeDefined()
      expect(await ui.find({ key: 'r-github-42-7' })).toBeUndefined()
      await ui.press({ key: 'p-github-42' })
      expect(await ui.find({ key: 'r-github-42-7' })).toBeDefined()
      await ui.press({ key: 'r-github-42-7' })
      expect(calls.some(argv => argv.slice(1).join(' ') === 'run rerun 42 --job 7 -R acme/app')).toBe(true)
      await ui.press({ key: 'p-github-42' })
      expect(await ui.find({ key: 'r-github-42-7' })).toBeUndefined()
      await ui.unmount()
    }
  })
})
