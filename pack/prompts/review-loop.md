---
description: Iterative review loop — reviewer finds issues, you fix, repeat until clean
---
Run an iterative review loop on the uncommitted changes (or last commit if clean). Use the subagent tool to invoke the "reviewer" agent. After each review:

1. Evaluate every finding (Critical, Warning, Suggestion) using your own judgment — the reviewer can be wrong.
2. For findings you agree with: fix them.
3. For findings you disagree with: note why and skip them. Include your reasoning in the next review round's context so the reviewer doesn't repeat them.
4. If you made any fixes: commit, then invoke the reviewer again. Pass along what was fixed AND what was intentionally skipped (with reasoning) so it focuses on new issues only.
5. Stop when: the reviewer finds nothing new worth fixing, or all remaining findings are ones you've already evaluated and rejected.

Rules:
- Each review round MUST tell the reviewer what was already fixed and what was deliberately skipped (with reasoning), so it doesn't repeat itself.
- Squash all fix commits into one clean commit at the end (via `git reset --soft` + `git commit`).
- Maximum 10 rounds (safety limit).

Context for the review: $@
