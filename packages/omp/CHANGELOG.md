# Changelog

## [0.2.2](https://github.com/diegomarino/lm-studio-warm/compare/omp-v0.2.1...omp-v0.2.2) (2026-08-20)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * lm-studio-warm-core bumped from ^0.2.1 to ^0.2.2

## [0.2.1](https://github.com/diegomarino/lm-studio-warm/compare/omp-v0.2.0...omp-v0.2.1) (2026-08-16)


### Bug Fixes

* **opencode:** keep the historical npm name — the registry forbids the rename ([d291788](https://github.com/diegomarino/lm-studio-warm/commit/d291788bd34c422b2e1ca4699d140647afee2ce2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * lm-studio-warm-core bumped from ^0.2.0 to ^0.2.1

## [0.2.0](https://github.com/diegomarino/lm-studio-warm/compare/omp-v0.1.0...omp-v0.2.0) (2026-08-16)


### ⚠ BREAKING CHANGES

* **core:** default lockDir moved from ~/.cache/omp/lm-studio-warm.lock to ~/.cache/lm-studio-warm/lock so omp, pi and opencode sessions contend on one lock. Explicitly configured lockDir values are unaffected.

### Features

* **core:** inject runtime profiles; config dirs and defaults supplied by wirings ([6d46462](https://github.com/diegomarino/lm-studio-warm/commit/6d46462dee3a532ddf4cd166d316a9244743583a))
* **core:** shared cross-runtime lock at ~/.cache/lm-studio-warm/lock with holder-recorded staleness ([154f064](https://github.com/diegomarino/lm-studio-warm/commit/154f0642183de653a74295a023eec0bc85555105))


### Bug Fixes

* **pi:** honor configured providers for eager warm; refactor(core): dedupe summarizeWarnings ([81ae835](https://github.com/diegomarino/lm-studio-warm/commit/81ae8356a685f0cbfd4b6e9ce96ec1b70f10dff0))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * lm-studio-warm-core bumped from ^0.1.0 to ^0.2.0
