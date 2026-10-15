import type { McpToolResult } from 'claude-code'

import type { Repo } from '../types'
import { jobsArgv, listArgv, retryFailedArgv, retryJobArgv } from './providers'

/** One thing the pane asks of GitLab. */
export type GitlabOp =
  | { op: 'list'; branch: string; perPage: number }
  | { op: 'jobs'; pipelineId: string }
  | { op: 'retryJob'; pipelineId: string; jobId: string }
  | { op: 'retryFailed'; pipelineId: string }

export type BackendKind = 'mcp-official' | 'mcp-local' | 'glab'

export const BACKEND_LABEL: Record<BackendKind, string> = {
  'mcp-official': 'MCP GitLab officiel',
  'mcp-local': 'MCP GitLab local',
  glab: 'glab',
}

/** The MCP servers to try, in order, for each kind. */
export type GitlabServers = { official: string[]; local: string[] }

type McpCall = { tool: string; args: Record<string, unknown> }

/**
 * The official GitLab MCP server (`/api/v4/mcp`): projects by `id` (path or
 * number), pipeline ids as integers; it retries a pipeline's failed jobs
 * (`save_pipeline`) but has no single-job retry.
 */
export function officialCall(repo: Repo, op: GitlabOp): McpCall | undefined {
  switch (op.op) {
    case 'list':
      return { tool: 'list_pipelines', args: { id: repo.path, ref: op.branch, per_page: op.perPage } }
    case 'jobs':
      return { tool: 'get_pipeline_jobs', args: { id: repo.path, pipeline_id: Number(op.pipelineId), per_page: 100 } }
    case 'retryJob':
      return undefined
    case 'retryFailed':
      return { tool: 'save_pipeline', args: { project_id: repo.path, pipeline_id: Number(op.pipelineId), action: 'retry' } }
  }
}

/** A local GitLab MCP server (gitlab-mcp family): numeric project ids, string pipeline / job ids. */
export function localCall(projectId: string, op: GitlabOp): McpCall {
  switch (op.op) {
    case 'list':
      return { tool: 'list_pipelines', args: { project_id: projectId, ref: op.branch, per_page: op.perPage } }
    case 'jobs':
      return { tool: 'list_pipeline_jobs', args: { project_id: projectId, pipeline_id: op.pipelineId, per_page: 100 } }
    case 'retryJob':
      return { tool: 'retry_pipeline_job', args: { project_id: projectId, job_id: op.jobId } }
    case 'retryFailed':
      return { tool: 'retry_pipeline', args: { project_id: projectId, pipeline_id: op.pipelineId } }
  }
}

export function glabArgv(repo: Repo, op: GitlabOp): string[] {
  switch (op.op) {
    case 'list':
      return listArgv(repo, op.branch)
    case 'jobs':
      return jobsArgv(repo, op.pipelineId)
    case 'retryJob':
      return retryJobArgv(repo, op.pipelineId, op.jobId)
    case 'retryFailed':
      return retryFailedArgv(repo, op.pipelineId)
  }
}

function mcpText(result: McpToolResult): string {
  return result.content
    .map(block => (block.type === 'text' ? (block as { text?: string }).text ?? '' : ''))
    .join('\n')
    .trim()
}

/** What an MCP tool answered, as data; throws with the server's words when it failed. */
export function mcpData(result: McpToolResult): unknown {
  const text = mcpText(result)
  if (result.isError) throw new Error(text.split('\n')[0] || 'MCP error')
  if (result.structuredContent !== undefined) return result.structuredContent
  try {
    return JSON.parse(text || 'null')
  } catch {
    throw new Error(text.split('\n')[0] || 'unexpected MCP answer')
  }
}

/** Same server, whatever the spelling (`plugin:gitlab:gitlab`, `plugin_gitlab_gitlab`). */
export function serverKey(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()
}

/**
 * The GitLab MCP servers of this session: the configured ones first, then
 * any other server whose tools give it away (`save_pipeline` is the official
 * server's; `retry_pipeline_job` a local gitlab-mcp's).
 */
export function detectServers(configured: GitlabServers, toolNames: readonly string[]): GitlabServers {
  const out: GitlabServers = { official: [...configured.official], local: [...configured.local] }
  const known = new Set([...out.official, ...out.local].map(serverKey))
  for (const name of toolNames) {
    const match = /^mcp__(.+)__(save_pipeline|retry_pipeline_job)$/.exec(name)
    if (!match?.[1] || known.has(serverKey(match[1]))) continue
    known.add(serverKey(match[1]))
    out[match[2] === 'save_pipeline' ? 'official' : 'local'].push(match[1])
  }

  return out
}
