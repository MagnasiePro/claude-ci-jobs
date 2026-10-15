import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult, RenderElement } from 'claude-code'

import { detectServers } from './gitlab'
import { progressOf, railSvg, textRail } from './track'
import { glJobs, glPipelines, stagesOf, parseJobs, parsePipelines, parseRemote, pushedBranch, retryJobArgv } from './providers'

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
function host(on: On, calls: string[][]) {
  const clock = mock.clock(on)
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
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)

  return clock
}

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 100 } as never,
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
    const clock = host(on, calls)
    on('tool.call', () => ({ result: {} as never, text: 'pushed' }))
    await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/x' })
    await clock.advance(2_500)
    expect(calls.some(argv => argv.join(' ').includes('--branch feat/x'))).toBe(true)
    const ui = await $.ui.mount({ plugin: 'ci-jobs', surface: 'desktop', ...BAND })
    expect(await ui.find({ type: 'Text', text: /feat\/x/ })).toBeDefined()
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
        ...BAND,
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

const mcpOk = (data: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false } })
const mcpErr = (text: string) => ({ value: { content: [{ type: 'text', text }], isError: true } })

/** A GitLab repo whose official MCP knows nothing of the project, served by the local MCP. */
function gitlabHost(on: On, calls: string[]): void {
  mock.clock(on)
  on('process.run', ($, e) => {
    const [bin, ...args] = e.argv
    calls.push(`process ${e.argv.join(' ')}`)
    if (bin === 'git' && args[0] === 'remote') return { value: ok('git@forge.example.com:grp/app.git\n') }
    if (bin === 'git' && args[0] === 'rev-parse') return { value: ok('develop\n') }

    return { value: { ...ok(''), exitCode: 1, stderr: 'glab: no token' } }
  })
  on('mcp.call', ($, e) => {
    calls.push(`${e.server} ${e.tool} ${JSON.stringify(e.args)}`)
    if (e.server === 'plugin:gitlab:gitlab') return mcpErr('404 Project Not Found')
    if (e.tool === 'discover_tools') return mcpOk({ activated: 'pipelines' })
    if (e.tool === 'list_projects') return mcpOk([{ id: '77', path_with_namespace: 'grp/app' }])
    if (e.tool === 'list_pipelines') return mcpOk([{ id: '5', ref: 'develop', status: 'failed', source: 'push' }])
    if (e.tool === 'list_pipeline_jobs') return mcpOk([{ id: '12', name: 'test', stage: 'test', status: 'failed' }])
    if (e.tool === 'retry_pipeline_job') return mcpOk({ id: '13', status: 'pending' })

    return mcpErr(`unexpected ${e.tool}`)
  })
  on('tool.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.render', ($, e) => h($.ui.resolve(e).Box, {}) as RenderElement)
}

describe('stages', () => {
  test('rolls jobs up into stages and a progress track', () => {
    const stages = stagesOf([
      { id: '1', name: 'a', stage: 'build', status: 'success' },
      { id: '2', name: 'b', stage: 'test', status: 'success' },
      { id: '3', name: 'c', stage: 'test', status: 'pending' },
      { id: '4', name: 'd', stage: 'deploy', status: 'manual' },
    ])
    expect(stages.map(stage => [stage.name, stage.status, stage.done])).toEqual([
      ['build', 'success', 1],
      ['test', 'running', 1],
      ['deploy', 'manual', 0],
    ])
    const progress = progressOf(stages, 'running')
    expect(progress.percent).toBe(50)
    expect(progress.current?.name).toBe('test')
    expect(progress.bounds).toEqual([0.25, 0.75])
    const svg = railSvg(stages, 'running')
    expect(svg).toContain('width="100%"')
    expect(svg).toContain('<title>test · 1/2</title>')
    expect(svg).toContain('<animate')
    const rail = textRail(stages, 20)
    expect(rail.map(part => part.text).join('').length).toBeGreaterThan(15)
    expect(progressOf(stages, 'success').percent).toBe(100)
  })
})

describe('gitlab chain', () => {
  test('falls from the official MCP to the local one, and retries a job there', async ($, on) => {
    const calls: string[] = []
    gitlabHost(on, calls)
    await $.command.run({
      command: 'ci-jobs',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    const ui = await $.ui.mount({ plugin: 'ci-jobs', surface: 'desktop', ...BAND })
    expect(await ui.find({ key: 'p-gitlab-5' })).toBeDefined()
    await ui.press({ key: 'p-gitlab-5' })
    expect((await ui.find({ type: 'Text', text: /via/ }))?.text).toContain('MCP GitLab local')
    await ui.press({ key: 'r-gitlab-5-12' })
    expect(calls).toContain('gitlab-forge retry_pipeline_job {"project_id":"77","job_id":"12"}')
    expect(calls.some(call => call.startsWith('plugin:gitlab:gitlab list_pipelines'))).toBe(true)
    expect(calls.some(call => call.startsWith('process glab'))).toBe(false)
    await ui.unmount()
  })

  test('parses GraphQL-ish answers', () => {
    const pipes = glPipelines({ pipelines: { nodes: [{ id: 'gid://gitlab/Ci::Pipeline/9', status: 'SUCCESS', ref: 'main' }] } }, 'main')
    expect(pipes[0]).toMatchObject({ key: 'gitlab-9', status: 'success' })
    const jobs = glJobs({ jobs: { nodes: [{ id: 'gid://gitlab/Ci::Build/3', name: 'lint', stage: { name: 'test' }, status: 'FAILED' }] } })
    expect(jobs[0]).toMatchObject({ id: '3', stage: 'test', status: 'failed' })
  })

  test('finds GitLab MCP servers by their tools', () => {
    const found = detectServers({ official: ['plugin:gitlab:gitlab'], local: ['gitlab-forge'] }, [
      'mcp__plugin_gitlab_gitlab__save_pipeline',
      'mcp__other_gl__retry_pipeline_job',
      'Bash',
    ])
    expect(found).toEqual({ official: ['plugin:gitlab:gitlab'], local: ['gitlab-forge', 'other_gl'] })
  })
})
