# lm-studio-warm-core

Runtime-agnostic core of [lm-studio-warm](https://github.com/diegomarino/lm-studio-warm): a
deterministic LM Studio model pre-warm gate. It owns the cross-process lock, eviction planning,
`lms` CLI client, model discovery, and two-tier config loading — with no dependency on any host
runtime (omp, opencode, etc).

This package has no user-facing entry point on its own; it is consumed by runtime adapters such as
`omp-lm-studio-warm`.

Full configuration reference: TODO (tracked for a later task).
