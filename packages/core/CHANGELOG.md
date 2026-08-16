# Changelog

## [0.2.0](https://github.com/diegomarino/lm-studio-warm/compare/core-v0.1.0...core-v0.2.0) (2026-08-16)


### ⚠ BREAKING CHANGES

* **core:** default lockDir moved from ~/.cache/omp/lm-studio-warm.lock to ~/.cache/lm-studio-warm/lock so omp, pi and opencode sessions contend on one lock. Explicitly configured lockDir values are unaffected.

### Features

* **core:** inject runtime profiles; config dirs and defaults supplied by wirings ([6d46462](https://github.com/diegomarino/lm-studio-warm/commit/6d46462dee3a532ddf4cd166d316a9244743583a))
* **core:** shared cross-runtime lock at ~/.cache/lm-studio-warm/lock with holder-recorded staleness ([154f064](https://github.com/diegomarino/lm-studio-warm/commit/154f0642183de653a74295a023eec0bc85555105))


### Bug Fixes

* **core:** catch concatenated embedding names in the degraded-path filter ([83f87f0](https://github.com/diegomarino/lm-studio-warm/commit/83f87f085660244daf94d481b3adc4ef52367247))
* **core:** reject failed model discovery instead of resolving an empty catalog ([2b5840c](https://github.com/diegomarino/lm-studio-warm/commit/2b5840c01720934278b9692122abe3ef1e1f06b7))
* **pi:** honor configured providers for eager warm; refactor(core): dedupe summarizeWarnings ([81ae835](https://github.com/diegomarino/lm-studio-warm/commit/81ae8356a685f0cbfd4b6e9ce96ec1b70f10dff0))
