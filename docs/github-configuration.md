# GitHub Actions Configuration

The `claude.yml` workflow automates issue implementation and PR review using Claude Code. It requires two secrets and one optional variable, configured at **Settings → Secrets and variables → Actions**.

---

## Secrets

| Secret | Description |
|---|---|
| `ANTHROPIC_API_TOKEN` | Anthropic API key passed to `claude-code-action` in every Claude job |
| `AGENT_TOKEN` | GitHub PAT with `repo` scope. Used by Claude to read issues and PRs, create and push branches, open pull requests, and post review comments. Must be a PAT (not the built-in `GITHUB_TOKEN`) so that PRs created by Claude can themselves trigger workflows |

---

## Variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_NAME` | `Squirrel` | The Slack bot's display name. Injected into every Claude prompt so that any user-facing strings or system prompt text Claude writes uses the correct name |
| `BOT_ACTOR` | _(empty)_ | GitHub login of the account associated with `AGENT_TOKEN`. When set, comments from this account are treated as bot comments and ignored to prevent reply loops. Set this to the username of your dedicated machine user |

To set a value: **Settings → Secrets and variables → Actions → Variables → New repository variable**.

---

## How the tokens are used

```
build-claude-prompt.js          claude-code-action
─────────────────────           ──────────────────
Reads issue / PR data           Makes code changes
via GitHub REST API   ←──────── Posts reviews
                                Creates PRs
         ↑                           ↑
   AGENT_TOKEN                 AGENT_TOKEN
                          ANTHROPIC_API_TOKEN
```

The built-in `GITHUB_TOKEN` (auto-provided by Actions) is used only in `ci.yml` for uploading coverage artifacts — no configuration required.

---

## Required PAT scopes

When creating the `AGENT_TOKEN` personal access token:

| Scope | Why |
|---|---|
| `repo` | Read issues, PRs, and code; push branches; create PRs |
| `pull_requests: write` (fine-grained) | Post review comments |
