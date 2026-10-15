# ci-jobs — CI band for Claude Code

A Claude Code mod that shows the **GitHub Actions / GitLab CI pipelines of the current session** in a band right above the prompt, terminal and desktop alike.

- Tracks the branch checked out in the session's folder, plus every branch pushed during the session (`git push`, `gh pr create`, `glab mr create` run by Claude); one line per branch, its latest pipeline.
- Each line is a **fluid progress rail**, one rounded segment per stage sized by its jobs, filled in the stage's colour (purple running, amber manual, red failed, green done); the stage at work pulses with a light sweeping across it, and hovering a segment names the stage. It fills whatever width the band has. The terminal draws it as coloured `━━━ ━━──` segments.
- Click a line (`⌄` / `⌃`) to open the detail: stages and their jobs with status and duration, `↻` to retry a job, **↻ Relancer les échecs** for the failed jobs, **Ouvrir ↗** for the pipeline page.
- Refreshes every 20 s while something runs (every 80 s otherwise), and right after a push.

```
● feat: login form  feat/login   ━━━━━━━━ ━━━━━━──── ──────  test     62%  ⌄
✓ chore: deps       main         ━━━━━━━━ ━━━━━━━━━━ ━━━━━━  terminé 100%  ⌃
    ✓ build 1/1
      ✓ docker-build                1m02  ↻
    ✓ test 2/2
      ✓ lint                          18s  ↻
      ✓ unit                          41s  ↻
    ✓ deploy 1/1
      ✓ update-helm                   12s  ↻
    Ouvrir ↗  2h · via MCP GitLab local
```

## Requirements

- The session's folder is a git repository whose `origin` points at GitHub or GitLab.
- **GitHub**: `gh` authenticated (`gh auth login`).
- **GitLab**: any one of these, tried in this order for every call:
  1. the **official GitLab MCP server** (`https://<gitlab>/api/v4/mcp`) connected in Claude — default name `plugin:gitlab:gitlab` (the GitLab plugin). It lists pipelines and jobs and retries a pipeline's failed jobs; it has no single-job retry, so that falls through to the next backend;
  2. a **local GitLab MCP server** (gitlab-mcp family: `list_pipelines`, `list_pipeline_jobs`, `retry_pipeline_job`, `retry_pipeline`) — default name `gitlab-forge`. Its `pipelines` toolset is activated through `discover_tools` when the server has one, and the project's numeric id is looked up with `list_projects` (some servers allow-list projects by id only);
  3. **`glab`** authenticated (`glab auth login --hostname <host>`).

  A backend that fails (not connected, project unknown to it, no token) is skipped for 5 minutes for reads, and the next one answers. The open detail says which one served it (`via MCP GitLab local`). Other servers exposing `save_pipeline` (official) or `retry_pipeline_job` (local) are picked up on their own.

## Install

In a Claude Code terminal session:

```
/plugin install ci-jobs --marketplace MagnasiePro/claude-ci-jobs
```

Answer `y` to add the marketplace, then pick a scope (user scope first). The mod also loads in Claude desktop's local sessions once installed at the user scope.

## Use

- The band shows on its own once a tracked branch has a pipeline; `/ci-jobs` refreshes it, `/ci-jobs refresh` also re-reads the repository. The engine's `[-]` folds the band.
- Options (`/config` → `ci-jobs.*`):
  - `pollSeconds` (default 20): refresh interval.
  - `gitlabMcpOfficial` (default `plugin:gitlab:gitlab`): official GitLab MCP server name(s) as `/mcp` lists them, comma-separated.
  - `gitlabMcpLocal` (default `gitlab-forge`): local GitLab MCP server name(s), comma-separated.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
