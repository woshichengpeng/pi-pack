# Grammar Fix Extension

Automatically corrects English grammar using a cheap model (GPT-4o-mini, GPT-4o, or Gemini Flash). Does **not** consume the main agent's context window.

## Modes

### Async (default)
- Your input is sent immediately — no delay
- Grammar correction runs in the background
- Corrected text is shown in a widget above the editor
- LLM sees the corrected text via context rewriting (your original is preserved in session)

### Sync (`/grammar sync`)
- Input is intercepted before sending
- Auto-replaced with corrected text
- Slightly slower (waits for correction)

## Commands

| Command | Description |
|---------|-------------|
| `/grammar` | Toggle on/off |
| `/grammar on` | Enable |
| `/grammar off` | Disable |
| `/grammar sync` | Toggle sync mode |
| `/grammar model` | Show which model is being used |

## Shortcut

| Key | Description |
|-----|-------------|
| `Ctrl+Shift+G` | Fix grammar of current editor text (before submitting) |

## Model Priority

Uses the cheapest available model:

1. `github-copilot/gpt-4o-mini`
2. `openai/gpt-4o-mini`
3. `github-copilot/gpt-4o`
4. `openai/gpt-4o`
5. `google/gemini-2.5-flash`

## How Context Rewriting Works

In async mode, the extension uses pi's `context` event to rewrite your messages in the deep copy sent to the LLM. This means:

- **Session stores your original text** (what you actually typed)
- **LLM sees corrected text** (proper grammar)
- **Widget shows you the correction** (so you can learn)

This works even after you've already sent the message — the correction is applied to subsequent LLM calls.
