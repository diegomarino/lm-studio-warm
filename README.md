# omp-lm-studio-warm (repository index)

An [omp (oh-my-pi)](https://github.com/oh-my-pi) plugin that pre-warms LM
Studio models before every `lm-studio` completion stream, making cold loads and
RAM-pressure failures deterministic.

**The implementation does not live on `main` (yet).** It lives on branch
`feature/omp-lm-studio-warm`, checked out in the linked worktree
`.worktrees/omp-lm-studio-warm/` (partially uncommitted — see the handoff).
`main` currently holds only documentation.

## Where to read, in order

1. **Design spec** — `docs/superpowers/specs/2026-08-10-omp-lm-studio-warm-design.md`
   (what and why; status: Accepted).
2. **Implementation plan** — `docs/superpowers/plans/2026-08-10-omp-lm-studio-warm.md`
   (how; see its "Deviations from plan" note for post-approval decisions).
3. **The product** — branch `feature/omp-lm-studio-warm` /
   `.worktrees/omp-lm-studio-warm/`: source in `src/`, consumer docs in its
   `README.md`, tests in `test/` (`bun test`).
4. **Audits** — `docs/audits/2026-08-11-6ab77c9/`: five adversarial audit
   reports, the consolidated `fixes-backlog-2026-08-11.md`, and the fix ledger
   `fixes-backlog-2026-08-11-fixes-2026-08-11.md`.
5. **Task state** — `.superpowers/sdd/2026-08-10-omp-lm-studio-warm/progress.md`
   (canonical ledger) and `.remember/remember.md` (session handoff).
