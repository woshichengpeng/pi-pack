---
description: Iterative review loop — reviewer finds issues, you fix, repeat until clean
---
Run an iterative review loop on the uncommitted changes (or last commit if clean). Use the subagent tool to invoke the "reviewer" agent. After each review:

1. If the reviewer finds **Critical** issues: fix them, `git add -A && git commit`, then invoke the reviewer again with updated context describing what was already found and fixed — so it focuses only on NEW issues.
2. If the reviewer finds only **Warnings/Suggestions** but no Critical issues: evaluate each one. Fix what makes sense, skip what's nitpicking or wrong. Commit and run one final review.
3. If the reviewer finds **no Critical or Warning issues**: stop the loop.

Rules:
- Each review round should tell the reviewer what was already fixed so it doesn't repeat itself.
- The reviewer may be wrong — use your judgment. If a "Critical" finding is actually incorrect or irrelevant, skip it and note why.
- Squash all fix commits into one clean commit at the end (via `git reset --soft` + `git commit`).
- Maximum 10 rounds (safety limit).

Context for the review: $@
