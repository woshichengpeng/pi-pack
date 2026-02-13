# AGENTS.md

This file provides guidance to AI coding agents and human contributors working in this repository.

## Project Overview

Personal collection of [pi](https://github.com/badlogic/pi-mono) extensions, skills, prompt templates, subagent definitions, and themes — installed globally via symlinks.

pi source repo: `../pi-mono` (or clone from https://github.com/badlogic/pi-mono to `/tmp/pi-mono`)

## Structure

- `.pi/extensions/installer/` — project-level `/install` command (auto-loaded when pi opens this repo)
- `pack/extensions/` — pi extensions (`plan-mode`, `subagent`, `copilot-models`)
- `pack/agents/` — subagent definitions (markdown with frontmatter: `name`, `description`, `tools`, `model`, `thinkingLevel`)
- `pack/prompts/` — prompt templates (markdown with frontmatter, `$@` for args, `{previous}` for chain output)
- `pack/skills/` — pi skills (each a directory with `SKILL.md`)
- `pack/themes/` — pi themes

## Dev Commands

- **Install**: run `pi` in repo root, then `/install` — symlinks `pack/*` to `~/.pi/agent/`, runs `npm install` for items with `package.json`, then auto-runs runtime reload
- **Reload**: `/reload` in any pi session after changes (or run `/install` again)

## Code Style

- Extensions are TypeScript (`.ts`), exported as `export default function(pi: ExtensionAPI) { ... }`
- Agents/prompts are Markdown with YAML frontmatter
- Use `node:` prefix for Node.js built-in imports (`import * as fs from "node:fs"`)
- Tabs for indentation in TypeScript
- Imports: `@mariozechner/pi-coding-agent` for ExtensionAPI, `@mariozechner/pi-tui` for UI components, `@sinclair/typebox` for schemas

## Commit Conventions

Commits follow loose conventional style: `feat:`, `fix:`, `chore:` prefixes. Scope optional, e.g. `feat(plan-mode):`. Short imperative descriptions.

## Adding New Resources

1. Create in the appropriate `pack/` subdirectory
2. Run `/install` in pi (from this repo)
3. Run `/reload` in any pi session


## Language

Always reply in Chinese (中文).
