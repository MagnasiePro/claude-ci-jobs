export type Provider = 'github' | 'gitlab'

export type Repo = { provider: Provider; host: string; path: string }

export type Status =
  | 'success'
  | 'failed'
  | 'running'
  | 'pending'
  | 'canceled'
  | 'skipped'
  | 'manual'
  | 'unknown'

export type Job = {
  id: string
  name: string
  stage?: string
  status: Status
  durationSec?: number
  url?: string
}

export type Pipeline = {
  key: string
  id: string
  branch: string
  title: string
  status: Status
  url?: string
  createdAt?: string
  jobs?: Job[]
}

declare module 'claude-code' {
  interface PluginState {
    'ci-jobs': {
      repo: Repo | null
      branches: string[]
      pipelines: Pipeline[]
      expanded: Record<string, boolean>
      busy: Record<string, boolean>
      error: string | null
      updatedAt: number
      via: string | null
    }
  }
}
