<div align="center">

# opencode-agy

**Delegate scoped work to the Antigravity CLI (`agy` / Gemini) from OpenCode, in headless mode**

[![npm version](https://img.shields.io/npm/v/opencode-agy)](https://www.npmjs.com/package/opencode-agy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![OpenCode](https://img.shields.io/badge/OpenCode-1.x%20%7C%202.x-blue)

[Features](#features) • [Installation](#installation) • [Usage](#usage) • [Model tiers](#model-tiers) • [Safety](#safety--isolation) • [Development](#development)

</div>

A thin OpenCode plugin that delegates **review of supplied text** to the installed `agy` CLI in headless mode. It is not a security sandbox. It provides exactly two surfaces:

- **Tool `agy`** — the main agent calls it to delegate scoped work.
- **Slash command `/agy`** — type `/agy your task` directly in the TUI.

## Features

- 🤖 **One tool, one command** — minimal surface: a single `agy` tool, a single `/agy` slash command, one config hook
- 🧠 **Gemini 3.8 Flash by default** — other tiers and exact model overrides require an explicit opt-in
- 🔁 **Resumable (opt-in)** — previous conversations require explicit `OPENCODE_AGY_ALLOW_RESUME=1`
- 🛡️ **Failures are data** — timeouts, quota, auth, denied permissions, non-SUCCESS status and malformed JSON produce explicit errors
- 🔌 **OpenCode 1.x & 2.x** — separate v1/v2 entrypoints plus subprocess cancellation and a timeout watchdog

> [!NOTE]
> **Account and data safety:** This is an unofficial integration. Using Antigravity through a third-party host may violate applicable provider terms; no one can guarantee that your account will not be restricted. Delegated prompts and any included logs/files are processed by the Antigravity service. Never delegate secrets or sensitive project data without permission.

## Prerequisites

- The **Antigravity CLI** (`agy`): installed, on your `PATH`, and signed in (run `agy` once interactively to authenticate)
- **OpenCode** 1.x or 2.x

## Install the audited fork (OpenCode 2.x, Windows)

Do **not** use `opencode-agy@latest` from npm for this fork: the published
upstream package differs from the patched code and fails the OpenCode 2 loader
with a non-object default export.

Use OpenCode's **global plugin discovery directory**. This avoids local
`file:///...` entries in the `plugins` configuration, which some 2.0.x
versions silently ignore. See [OpenCode 2 plugin discovery
documentation](https://dev.opencode.ai/v2/docs/plugins) and [known v2
plugin-path issue](https://github.com/anomalyco/opencode/issues/49608).

From **PowerShell 5.1**, with the cloned repository at
`D:\agents\antigravity-for-opencode`:

```powershell
$repo = "D:\agents\antigravity-for-opencode"
Set-Location $repo
# Check out the reviewed/pinned commit for your version before building.
bun install --ignore-scripts
bun run typecheck
bun run build

$source = Join-Path $repo "dist\index.js"
$pluginDir = Join-Path $HOME ".config\opencode\plugins"
$target = Join-Path $pluginDir "agy-local.js"

if (!(Test-Path $source)) { throw "Built file missing: $source" }
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force
Get-Item $target | Select-Object FullName, Length
```

**Keep the OpenAI OAuth plugin** in your existing
`$HOME\.config\opencode\opencode.json` and remove any old
`file:///D:/agents/antigravity-for-opencode` or
`opencode-agy@latest` entry. The final `plugins` array can be:

```json
{
  "plugins": ["oc-codex-multi-auth"]
}
```

Do not replace the rest of the config or account settings.
Restart OpenCode and inspect loader logs (no model API call):

```powershell
opencode models --standalone --print-logs --log-level debug 2>&1 |
  Select-String -Pattern "agy-local|opencode-agy|loading plugin|failed to load plugin|WARN|ERROR" -Context 1,2
```

A healthy run shows `loading plugin` for `agy-local.js` without
`failed to load plugin`. Note: `opencode plugin list` lists managed
packages and is **not** a reliable test of discovery-loaded local files.

Then test `/agy` against a harmless text-only prompt while attended.
Only after a real OpenCode 2 + agy smoke test passes should you enable
unattended Ralph iterations. On subsequent rebuilds, copy `dist/index.js`
into the discovery directory again.

OpenCode 1.x uses a separate callable entrypoint `dist/v1.js`, and
its plugin loading procedure is different.

## Usage: review-only delegated Gemini (default)

The host OpenCode agent is responsible for editing code, running local Docker
builds/tests/containers, Git commits/pushes, PRs and merges. **Antigravity is
only the secondary reviewer** of excerpts, logs and test failures. No agent
executes remote deployment commands. Existing CI/CD pipelines are independent
of this plugin.

```json
{
  "prompt": "Review the following test failure and suggest a fix: AssertionError on src/utils.ts:42 ...",
  "tier": "flash-3.8-med",
  "timeout": "5m"
}
```

- Each call runs `agy -p` with `--sandbox` and `--output-format json`, starting
  in a fresh empty temporary working directory; `stdout` is decoded from the
  official `status` and `response` JSON fields. A non-`SUCCESS` status,
  malformed envelope, or a headless permission-denial notice is reported as
  `AGY_ERROR` rather than silently accepted as success.
- `yolo: true` / `--dangerously-skip-permissions` is rejected unless **the
  Windows user explicitly sets** `OPENCODE_AGY_ALLOW_YOLO=1`. Do not enable
  it for automated projects.
- `sandbox: false` is rejected in delegated review unless
  `OPENCODE_AGY_ALLOW_UNSANDBOXED=1` is set. On Windows the sandbox and
  permission behavior differ from Linux/macOS: **do not treat this as a
  security boundary against every file operation**.
- Passing `dir` is blocked by default. If necessary, set
  `OPENCODE_AGY_ALLOWED_DIRS` to an explicit **semicolon-separated list of
  canonical project directory paths**; only these directories and children
  may be passed through `--add-dir`. Their contents may be writable by agy;
  this option is **not** read-only. Never authorize your home folder,
  drive roots, credentials or private projects.
- Passing `project` (Google Cloud project selector) is blocked unless
  `OPENCODE_AGY_ALLOW_CLOUD_PROJECT=1` is set.
- `continue` and `conversation` are disabled for isolated review unless
  `OPENCODE_AGY_ALLOW_RESUME=1` is explicitly configured.
- Non-Flash tiers and exact `model` overrides are rejected by default.
  To enable additional models, set `OPENCODE_AGY_ALLOW_OTHER_MODELS=1` yourself.
- Delegated child processes receive a filtered subset of the parent
  environment, excluding common OpenAI, Codex, GitHub and cloud secret keys.
  The plugin cannot prevent access to secrets stored elsewhere.
- The calling main agent remains responsible for verifying results and
  continuing if Gemini reports a limitation.

### Windows and the local coding pipeline

Run OpenCode/Ralph with `--no-allow-all` and configure OpenCode 2
`permissions` separately: scoped shell command allowlists, local Docker
project resources, local Git write/push/merge, and deny unknown/privileged
commands when unattended. The Gemini plugin **does not grant Docker, GitHub,
Docker daemon, host filesystem, or SSH privileges** to OpenCode and cannot
enforce those main-agent permissions.

Do not run an unrestricted `docker system prune --volumes` or
`docker volume prune` as an automatic maintenance step. Prefer scoped
`docker compose -p <unique-project> ...` commands (with a reviewed compose
file) to avoid accidentally touching other containers/volumes. A Docker
daemon with host-mounted volumes or privileged containers is high trust.

### Review versus changing files

Giving Gemini text excerpts is the intended mode. If a particular review
needs local file inspection, the user must explicitly approve a narrow
`OPENCODE_AGY_ALLOWED_DIRS` entry. The plugin cannot guarantee read-only
file access on Windows; setting `dir` widens access.

### Optional arguments

The tool accepts `prompt`, `tier`, `timeout`, `model`, `continue`,
`conversation`, `dir`, `project`, `sandbox`, and `yolo`.
Use `continue` and `conversation` only for prior review-only sessions and only after opting in. Other models require opt-in.
Tier defaults to `flash-3.8-med` if available to the authenticated account.

### Slash command

```text
/agy Review this failing test and propose the smallest fix: ...
```

## Model tiers

The `hi` / `med` / `lo` suffix selects reasoning effort. Gemini 3.8 Flash tiers are enabled by default for delegated reviews; the remaining tiers require explicit opt-in. All tiers default to a 15-minute timeout.

| Tiers | Model | Account |
| --- | --- | --- |
| `flash-3.8-hi` / `flash-3.8-med` / `flash-3.8-lo` | Gemini 3.8 Flash | Pro & Ultra |
| `claude-sonnet-5-5-hi` / `claude-sonnet-5-5-med` / `claude-sonnet-5-5-lo` | Claude Sonnet 5.5 | Pro & Ultra |
| `claude-opus-5-5-hi` / `claude-opus-5-5-med` / `claude-opus-5-5-lo` | Claude Opus 5.5 | Pro & Ultra |
| `argon-4-hi` / `argon-4-med` / `argon-4-lo` | Gemini 4 Argon | **Ultra only** |

> [!NOTE]
> On Pro accounts, `argon-4-*` tiers fail with `MODEL_NOT_FOUND` until Ultra unlocks them. For reference, official Gemini 3.8 Flash limits (documentation facts, not enforced by this plugin): 1,000,000 input/context tokens and 65,536 max output tokens ([model card](https://deepmind.google/models/model-cards/gemini-3-8-flash)).

> [!WARNING]
> `flash-3.5-*`, `flash-3.6-*`, `flash-3.7-*`, and `pro-3.1-*` were removed (Enterprise-only upstream) and have **no aliases** — they return `INVALID_TIER`. Map old names: `flash-3.5-hi/med` → `flash-3.8-hi/med`, and the old default `flash-3.7-med` → `flash-3.8-med`.

## Safety & limits

This tool forwards selected text to an external model. The model and CLI
may retain context outside this process. A temporary working directory, a
shell-command sandbox, deny-on-Ask policies, an allowlist for `dir`, and
environment scrubbing are **defense-in-depth only**. They are not equivalent
to running under an isolated operating-system account or virtual machine.

- Never pass `.env`, private keys, credentials, tokens, customer records, or
  sensitive infrastructure configuration in review prompts.
- By default Gemini receives **no project directory**. Explicit `dir` access
  is powerful: it can enable writes as well as reads.
- `--sandbox` chiefly restricts terminal execution and does not make every
  filesystem tool read-only on Windows.
- In headless mode denied actions may return exit status 0: check the tool's
  structured status and stderr notices.
- The plugin's outgoing prompt and output scrubbing are best-effort and cannot protect secrets
  already sent to Gemini or exposed by the underlying CLI.
- The agy executable is resolved from PATH; review installations and avoid
  untrusted PATH entries. Pin this fork to a commit instead of following a
  third-party `@latest` release.
- Review the provider's terms: this is an unofficial way to orchestrate
  Antigravity via a third-party application.

## Development

```bash
bun install --ignore-scripts
bun test
bun run typecheck
bun run build:all
```

Windows CI runs host-compatible tests; Linux CI runs the full test
suite. A real local OpenCode 2.x + Agy 1.3.x smoke test is still needed
before unattended use. Tests cover argument mapping, denied permissions,
JSON statuses, optional directory access, process cancellation and timeouts.

## Philosophy

Pragmatic over clever. Minimal surface area. Failures are data, not crashes. The main agent owns verification.

---

Design inspired by [antigravity-for-claude-code](https://github.com/yuting0624/antigravity-for-claude-code).
