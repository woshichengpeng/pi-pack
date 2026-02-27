---
description: Review changes, commits, or design using the reviewer agent
---
Use the subagent tool to run the "reviewer" agent with this task:

Review the following: $@

If the user didn't specify a scope, review the uncommitted changes (or last commit if working tree is clean).

If the user specified a model (e.g. "model:xxx", "--model xxx", or "use xxx model"), pass it as the `model` parameter to the subagent tool to override the reviewer's default model.
