# ci-jobs — CI pane for Claude Code

A Claude Code mod that shows the **GitHub Actions / GitLab CI pipelines of the current session** in a side pane (the right-hand panel in Claude desktop, a docked pane in the fullscreen terminal).

- Tracks the branch checked out in the session's folder, plus every branch pushed during the session (`git push`, `gh pr create`, `glab mr create` run by Claude).
- Accordion: each pipeline folds / unfolds (`▸` / `▾`) to show its jobs with status, stage and duration.
- Retry: `↻` re-runs one job, **Relancer les échecs** re-runs the failed jobs of a pipeline, **Ouvrir ↗** opens it in the browser.
- Refreshes every 20 s while the pane is shown (configurable), and right after a push.

```
GitHub · acme/app                                  ⟳ 12s
Branches : feat/login, main · via gh
▾ ✗ CI · feat: login form   feat/login · 3m
    ✓ build                        1m02
    ✗ lint                           18s  ↻
    [ Relancer les échecs ]  Ouvrir ↗
▸ ✓ CI · chore: deps        main · 2h
```

## Requirements

- The session's folder is a git repository whose `origin` points at GitHub or GitLab.
- **GitHub**: `gh` authenticated (`gh auth login`).
- **GitLab**: any one of these, tried in this order for every call:
  1. the **official GitLab MCP server** (`https://<gitlab>/api/v4/mcp`) connected in Claude — default name `plugin:gitlab:gitlab` (the GitLab plugin). It lists pipelines and jobs and retries a pipeline's failed jobs; it has no single-job retry, so that falls through to the next backend;
  2. a **local GitLab MCP server** (gitlab-mcp family: `list_pipelines`, `list_pipeline_jobs`, `retry_pipeline_job`, `retry_pipeline`) — default name `gitlab-forge`. Its `pipelines` toolset is activated through `discover_tools` when the server has one, and the project's numeric id is looked up with `list_projects` (some servers allow-list projects by id only);
  3. **`glab`** authenticated (`glab auth login --hostname <host>`).

  A backend that fails (not connected, project unknown to it, no token) is skipped for 5 minutes for reads, and the next one answers. The pane says which one served it (`via MCP GitLab local`). Other servers exposing `save_pipeline` (official) or `retry_pipeline_job` (local) are picked up on their own.

## Install

In a Claude Code terminal session:

```
/plugin install ci-jobs --marketplace MagnasiePro/claude-ci-jobs
```

Answer `y` to add the marketplace, then pick a scope (user scope first). The mod also loads in Claude desktop's local sessions once installed at the user scope.

## Use

- The pane opens on its own at session start; reopen it with `/ci-jobs`, force a re-detection with `/ci-jobs refresh`.
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
