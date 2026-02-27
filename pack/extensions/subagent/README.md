# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
└── agents.ts            # Agent discovery logic
```

This pack also ships:
- `pack/agents/` — sample agent definitions (installed to `~/.pi/agent/agents`)
- `pack/prompts/` — workflow prompt templates (installed to `~/.pi/agent/prompts`)

## Installation

From this repo, run `/install` (see the root README). It symlinks:

- `pack/extensions/subagent` → `~/.pi/agent/extensions/subagent`
- `pack/agents/*.md` → `~/.pi/agent/agents/`
- `pack/prompts/*.md` → `~/.pi/agent/prompts/`

If you’re installing manually, place the extension under `~/.pi/agent/extensions/` and the agent/prompt files under `~/.pi/agent/agents/` and `~/.pi/agent/prompts/`.

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Background Mode

Add `background: true` to any subagent call to run it without blocking the conversation:

```
Run subagent in background with agent "worker" to refactor the auth module
```

- Returns immediately with a **job ID**
- Widget shows running job count (⏳)
- Notification when job completes
- Use `subagent_jobs` tool (or `/jobs` command) to check status and retrieve results

### Checking Results

The LLM can query jobs via the `subagent_jobs` tool:
- `{ action: "list" }` — list all jobs
- `{ action: "get", jobId: "job-1" }` — get result of a specific job
- `{ action: "clear" }` — remove finished jobs

Or use `/jobs` to see a quick summary interactively.

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/*.md` - User-level (always loaded)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same name when `agentScope: "both"`.

This pack provides the sample agents under `pack/agents/` and installs them to `~/.pi/agent/agents/` via `/install`.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Claude Haiku 4.5 (Copilot) | read, grep, find, ls, bash |
| `planner` | Implementation plans | Claude Sonnet 4.5 (Copilot) | read, grep, find, ls |
| `reviewer` | Code review | GPT-5.3-Codex (Copilot) | read, grep, find, ls, bash |
| `worker` | General-purpose | Claude Sonnet 4.5 (Copilot) | (all default) |

## Workflow Prompts

These prompt templates live in `pack/prompts/` and are installed to `~/.pi/agent/prompts/` via `/install`.

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
