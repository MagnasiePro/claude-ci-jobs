# ci-jobs — CI pane for Claude Code

A Claude Code mod that shows the **GitHub Actions / GitLab CI pipelines of the current session** in a side pane (the right-hand panel in Claude desktop, a docked pane in the fullscreen terminal).

- Tracks the branch checked out in the session's folder, plus every branch pushed during the session (`git push`, `gh pr create`, `glab mr create` run by Claude).
- Accordion: each pipeline folds / unfolds (`▸` / `▾`) to show its jobs with status, stage and duration.
- Retry: `↻` re-runs one job, **Relancer les échecs** re-runs the failed jobs of a pipeline, **Ouvrir ↗** opens it in the browser.
- Refreshes every 20 s while the pane is shown (configurable), and right after a push.

```
GitHub · acme/app                                  ⟳ 12s
Branches : feat/login, main
▾ ✗ CI · feat: login form   feat/login · 3m
    ✓ build                        1m02
    ✗ lint                           18s  ↻
    [ Relancer les échecs ]  Ouvrir ↗
▸ ✓ CI · chore: deps        main · 2h
```

## Requirements

- `gh` authenticated (`gh auth login`) for GitHub repositories.
- `glab` authenticated (`glab auth login --hostname <host>`) for GitLab repositories (gitlab.com or self-hosted; the host is read from the `origin` remote).
- The session's folder is a git repository whose `origin` points at GitHub or GitLab.

## Install

In a Claude Code terminal session:

```
/plugin install ci-jobs --marketplace MagnasiePro/claude-ci-jobs
```

Answer `y` to add the marketplace, then pick a scope (user scope first). The mod also loads in Claude desktop's local sessions once installed at the user scope.

## Use

- The pane opens on its own at session start; reopen it with `/ci-jobs`, force a re-detection with `/ci-jobs refresh`.
- `pollSeconds` (default 20) sets the refresh interval: `/config` → `ci-jobs.pollSeconds`.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT
