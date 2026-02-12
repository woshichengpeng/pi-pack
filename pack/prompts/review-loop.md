---
description: Iterative review loop — reviewer finds issues, you fix, repeat until clean
---
Run an iterative review loop on the uncommitted changes (or last commit if clean). Use the subagent tool to invoke the "reviewer" agent with session resume to maintain conversation context across rounds.

## Process

For the **first round**: invoke the reviewer with the initial review request (no sessionId). Save the returned `sessionId`.

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
- Maximum 10 rounds (safety limit).

Context for the review: $@
