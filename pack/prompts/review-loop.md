---
description: Iterative review loop — reviewer finds issues, you fix, repeat until clean
---
Run an iterative review loop. Use the subagent tool to invoke the "reviewer" agent with session resume to maintain conversation context across rounds.

## Determining Review Scope

The user's input determines what to review: $@

Interpret the scope flexibly:
- **Commit hash or range**: e.g. "abc123", "abc123..HEAD", "since abc123" → pass the exact range to the reviewer
- **Last N commits**: e.g. "last 3 commits" → review the range `HEAD~3..HEAD`
- **Design or architecture**: e.g. "review the caching design" → the reviewer will read relevant files and focus on design
- **Specific files**: e.g. "review src/auth/" → focused file review
- **Default** (no specific scope): review uncommitted changes, or last commit if working tree is clean

Pass this scope clearly to the reviewer agent in the first round so it knows exactly what to examine.

## Model Override

If the user specified a model (e.g. "model:xxx", "--model xxx", or "use xxx model"), pass it as the `model` parameter to every subagent invocation throughout the loop. Strip the model specifier from the review scope — don't pass it as part of the task text.

## Process

For the **first round**: invoke the reviewer with the review request including the scope (no sessionId). Save the returned `sessionId`.

For **each subsequent round**: invoke the reviewer using the **same sessionId**, so it retains full memory of previous findings and your responses. Your follow-up message should briefly state:
- What was fixed
- What was deliberately skipped (with reasoning)
- Ask it to focus on new issues only

After each review round:
1. Evaluate every finding (Critical, Warning, Suggestion) using your own judgment — the reviewer can be wrong.
2. For findings you agree with: fix them.
3. For findings you disagree with: note why and skip them.
4. If you made any fixes: commit, then resume the reviewer session.
5. Stop when: the reviewer finds nothing new worth fixing, or all remaining findings are ones you've already evaluated and rejected.

## Rules
- Use `sessionId` to resume the same reviewer across rounds — don't start a new session each time. If the session expires, start a fresh one with full context.
- Squash all fix commits into one clean commit at the end (via `git reset --soft` + `git commit`).
- When reviewing a commit range, always pass the original range to the reviewer so it stays focused on the right changes.
- Maximum 10 rounds (safety limit).
