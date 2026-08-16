# Changelog

## [0.2.1](https://github.com/diegomarino/lm-studio-warm/compare/pi-v0.2.0...pi-v0.2.1) (2026-08-16)


### Bug Fixes

* **opencode:** keep the historical npm name — the registry forbids the rename ([d291788](https://github.com/diegomarino/lm-studio-warm/commit/d291788bd34c422b2e1ca4699d140647afee2ce2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * lm-studio-warm-core bumped from ^0.2.0 to ^0.2.1

## [0.2.0](https://github.com/diegomarino/lm-studio-warm/compare/pi-v0.1.0...pi-v0.2.0) (2026-08-16)


### Features

* **pi:** native lm-studio provider with gated streams, eager warm and lock release ([70d0fa6](https://github.com/diegomarino/lm-studio-warm/commit/70d0fa6089d7456140401ce732b821f729431dca))
* **pi:** scaffold pi-lm-studio-warm with two-tier config and inactive paths ([157c90f](https://github.com/diegomarino/lm-studio-warm/commit/157c90f5b885d551384ad650a0e6ceb0ecc50901))


### Bug Fixes

* **pi:** correct example config path to ~/.pi/agent ([2aafd6e](https://github.com/diegomarino/lm-studio-warm/commit/2aafd6e0732edcc98b0297ddc58eaee83a2acc2f))
* **pi:** honor configured providers for eager warm; refactor(core): dedupe summarizeWarnings ([81ae835](https://github.com/diegomarino/lm-studio-warm/commit/81ae8356a685f0cbfd4b6e9ce96ec1b70f10dff0))
* **pi:** mirror omp UI strings and guards in gated streams ([c7d3dc9](https://github.com/diegomarino/lm-studio-warm/commit/c7d3dc9887d06be2ac5c8cfc6b470c64b739f4a1))
* **pi:** resolve openai-completions streams lazily with a compat-alias fallback ([126a62d](https://github.com/diegomarino/lm-studio-warm/commit/126a62d560e09a8365a19bd1089a48dda07bebd2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * lm-studio-warm-core bumped from ^0.1.0 to ^0.2.0
