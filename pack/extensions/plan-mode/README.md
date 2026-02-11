# Plan Mode Extension

Read-only exploration mode for safe code analysis.

## Features

- **Read-only tools**: Restricts available tools to read, bash, grep, find, ls, questionnaire
- **Bash allowlist**: Only read-only bash commands are allowed
- **Plan extraction**: Extracts numbered steps from `Plan:` sections
- **Progress tracking**: Widget shows completion status during execution
- **[DONE:n] markers**: Explicit step completion tracking
- **Auto-save**: Plans auto-saved to `.pi/plans/` as Markdown with checkboxes
- **Plan browsing**: `/plans` command lists saved plans
- **Session persistence**: State survives session resume

## Commands

- `/plan` - Toggle plan mode
- `/todos` - Show current plan progress
- `/plans` - List and view saved plans
- `Ctrl+Alt+P` - Toggle plan mode (shortcut)

## Plan Files

Plans are automatically saved to `.pi/plans/` in the project directory when created in plan mode. Each plan is a Markdown file with:

- Timestamp and slug-based filename (e.g., `2026-02-11T21-18-00-refactor-auth-module.md`)
- Checkbox list that updates as steps are completed during execution
- Full plan output from the assistant

Add `.pi/plans/` to `.gitignore` if you don't want plans in version control:

```
# .gitignore
.pi/plans/
```

Or keep them tracked for team reference — they're valid Markdown with task lists.

## Usage

1. Enable plan mode with `/plan` or `--plan` flag
2. Ask the agent to analyze code and create a plan
3. The agent should output a numbered plan under a `Plan:` header:

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

4. Plan is auto-saved to `.pi/plans/`
5. Choose how to execute:
   - **Execute the plan (track progress)** — keeps full conversation context
   - **Execute in clean context (plan only)** — clears all prior context, LLM starts fresh with only the plan steps and original plan details. Useful for long planning sessions where the accumulated context would be noise.
6. During execution, the agent marks steps complete with `[DONE:n]` tags
7. Progress widget shows completion status
8. Plan file checkboxes update in real-time

## How It Works

### Plan Mode (Read-Only)
- Only read-only tools available
- Bash commands filtered through allowlist
- Agent creates a plan without making changes
- Plan auto-saved to `.pi/plans/`

### Execution Mode
- Full tool access restored
- Agent executes steps in order
- `[DONE:n]` markers track completion
- Widget shows progress
- Plan file checkboxes update on each completion

### Clean Execution Mode
- Same as Execution Mode, but all prior conversation context is stripped
- The LLM sees only: the plan steps, the original plan details, and the execute message
- Ideal when the planning phase was long/exploratory and the context would confuse execution
- Session history is still preserved (you can go back), only the LLM context is cleaned

### Command Allowlist

Safe commands (allowed):
- File inspection: `cat`, `head`, `tail`, `less`, `more`
- Search: `grep`, `find`, `rg`, `fd`
- Directory: `ls`, `pwd`, `tree`
- Git read: `git status`, `git log`, `git diff`, `git branch`
- Package info: `npm list`, `npm outdated`, `yarn info`
- System info: `uname`, `whoami`, `date`, `uptime`

Blocked commands:
- File modification: `rm`, `mv`, `cp`, `mkdir`, `touch`
- Git write: `git add`, `git commit`, `git push`
- Package install: `npm install`, `yarn add`, `pip install`
- System: `sudo`, `kill`, `reboot`
- Editors: `vim`, `nano`, `code`
