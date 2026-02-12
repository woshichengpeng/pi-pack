# Copilot Models Extension

Automatically discovers and registers additional GitHub Copilot models by querying the live `/models` API endpoint.

## Prerequisites

Must be logged in to GitHub Copilot first:

```
/login github-copilot
```

## What It Does

On session start, the extension:

1. Checks for existing `github-copilot` models (set up by `/login`)
2. Fetches the full model catalog from the Copilot API
3. Filters for chat-capable models with tool call support
4. Registers any models not already built-in

This means new models added to your Copilot subscription appear automatically without waiting for a pi update.

## Commands

- `/copilot-models` — List all registered Copilot models (built-in + discovered)
- `/copilot-models refresh` — Re-fetch the model catalog and register new models

## Status Indicator

When new models are discovered, a `🤖 +N copilot` indicator appears in the footer.

## How It Works

The extension uses the same authentication and headers as the built-in Copilot models. It calls `GET {baseUrl}/models` to retrieve the full catalog, then registers new models using `pi.registerProvider()`.

Model configuration is inferred from the API response:
- **API type**: Based on `supported_endpoints` (completions vs responses)
- **Reasoning**: Based on model family (Claude, o-series, GPT-5, etc.)
- **Vision**: Based on vendor (Anthropic, OpenAI, Google, xAI)
- **Context/tokens**: From the API's `capabilities.limits`
- **Cost**: Always $0 (Copilot subscription)
