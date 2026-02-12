---
name: repo-init
description: Analyze a repository and generate an AGENTS.md file — a concise guide for both human contributors and AI coding agents. Use when onboarding to a new repo or setting up agent-friendly documentation.
---

# Repo Init

Generate an `AGENTS.md` at the repository root. This file serves as the single source of truth for both human contributors and AI coding agents (Claude Code, Copilot, pi, etc.) working in the repo.

## Process

1. **Analyze the repository** — read project structure, config files, and git history to understand the codebase:
   - `package.json`, `tsconfig.json`, `Makefile`, `Cargo.toml`, `pyproject.toml`, etc.
   - Linter/formatter configs: `.eslintrc*`, `.prettierrc*`, `biome.json`, `.editorconfig`, `rustfmt.toml`, etc.
   - Existing agent rules: `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, `CLAUDE.md`
   - CI configs: `.github/workflows/`, `Jenkinsfile`, etc.
   - Recent git history: `git log --oneline -20`

2. **Check for an existing `AGENTS.md`** — if one exists, improve it rather than overwriting.

3. **Write `AGENTS.md`** following the template below.

## Template

The output must be a **single Markdown file**, concise (20–40 lines ideal, 60 lines max), with this structure:

```markdown
# AGENTS.md

This file provides guidance to AI coding agents and human contributors working in this repository.

## Project Overview
<!-- One sentence: what this project is. -->

## Structure
<!-- Key directories only. 3-8 lines. -->

## Build & Dev Commands
<!-- Essential commands: build, test, lint, run, single-test. One line each. -->

## Code Style
<!-- Indentation, naming, imports, formatting tools. Keep it short. -->

## Testing
<!-- Framework, naming convention, how to run one test. -->

## Commit Conventions
<!-- Infer from git log. e.g., conventional commits, prefix patterns. -->
```

## Rules

- **Be specific to this repo** — no generic boilerplate. Every line should be verifiable from the codebase.
- **Omit sections that don't apply** — no tests? skip Testing. No build step? skip Build.
- **Add sections if relevant** — e.g., Architecture, Security, Monorepo Notes, Agent-Specific Tips.
- **Merge existing rules** — if `.cursorrules`, `CLAUDE.md`, or copilot instructions exist, incorporate their content (don't just link to them).
- **Prefer examples over prose** — show a command, a path, a pattern, rather than describing it.
- **Tone: direct and instructional** — imperative voice, no filler.
