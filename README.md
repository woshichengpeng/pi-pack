# pi-pack

Personal collection of [pi](https://github.com/badlogic/pi) extensions, skills, prompts, agents, and themes.

## Install

```bash
git clone https://github.com/woshichengpeng/pi-pack.git
cd pi-pack
pi
```

Then run:

```
/install
```

This symlinks everything in `pack/` to `~/.pi/agent/`, making them globally available across all projects.

## Structure

```
pi-pack/
├── .pi/
│   └── extensions/
│       └── installer/          # /install command (project-level, auto-loaded)
├── pack/
│   ├── extensions/             # Pi extensions
│   │   ├── plan-mode/
│   │   └── subagent/
│   ├── skills/                 # Pi skills
│   ├── prompts/                # Prompt templates
│   ├── agents/                 # Subagent definitions
│   └── themes/                 # Pi themes
└── README.md
```

## What's Included

### Extensions

| Extension | Description |
|-----------|-------------|
| **plan-mode** | Think before you act — plan mode for pi |
| **subagent** | Delegate tasks to specialized sub-agents with isolated context |

### Prompts

| Prompt | Description |
|--------|-------------|
| `/implement` | scout → planner → worker workflow |
| `/scout-and-plan` | scout → planner (no implementation) |
| `/implement-and-review` | worker → reviewer → worker workflow |

## Adding Resources

1. Drop into the appropriate `pack/` subdirectory
2. Run `/install` in pi (from this repo)
3. Run `/reload` in any pi session to pick it up
