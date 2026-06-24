## [2.5.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.5.0...v2.5.1) (2026-06-05)

### Bug Fixes

- **chat:** handle stopped chat replay content ([2db3ccf](https://github.com/elohmeier/grafana-pi-app/commit/2db3ccfbd1e2b0cd9c0e00ed9f619b5edcb1f4a4))

# [2.5.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.4.1...v2.5.0) (2026-06-05)

### Features

- **chat:** replace dashboard bootstrap ([7cf7ac8](https://github.com/elohmeier/grafana-pi-app/commit/7cf7ac8040f422cf6e2a335ab6bd788d18aa6618))

## [2.4.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.4.0...v2.4.1) (2026-06-05)

### Bug Fixes

- **chat:** improve artifact tool renderers ([c8538b9](https://github.com/elohmeier/grafana-pi-app/commit/c8538b917717c6dbf2241c399af4b34b29a49af1))
- render nested Prometheus tool panels ([aab6a8c](https://github.com/elohmeier/grafana-pi-app/commit/aab6a8cfb5e102c6731cbe81476aad913c4b4f50))

# [2.4.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.3.0...v2.4.0) (2026-06-05)

### Features

- **chat:** add artifact registry ([b87ddb6](https://github.com/elohmeier/grafana-pi-app/commit/b87ddb6f6a44d33cb98591d2c15abfd1608b3383))

# [2.3.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.2.2...v2.3.0) (2026-06-05)

### Features

- add assistant safety workflows ([c1d89d2](https://github.com/elohmeier/grafana-pi-app/commit/c1d89d293b2f65d9b6c04f2c244b922faea4bb48))
- add bootstrap tool ([67e9915](https://github.com/elohmeier/grafana-pi-app/commit/67e9915446e915df34b4af8a76a948846ae2aa22))
- add configurable model thinking ([0d9871b](https://github.com/elohmeier/grafana-pi-app/commit/0d9871b19713dae1986d9e3cdb070482ad6dceb3))
- add dashboard design subagent ([117a169](https://github.com/elohmeier/grafana-pi-app/commit/117a169e5a7c8d38c3e21a9b7aaeaff396fc69f3))

## [2.2.2](https://github.com/elohmeier/grafana-pi-app/compare/v2.2.1...v2.2.2) (2026-06-03)

### Bug Fixes

- improve tool renderer & error handling ([3578bdd](https://github.com/elohmeier/grafana-pi-app/commit/3578bdd4fcdae15fc10b1d466dcbd01c4ed47bc8))

## [2.2.1](https://github.com/elohmeier/grafana-pi-app/compare/v2.2.0...v2.2.1) (2026-05-29)

### Reverts

- Revert "feat: add InfluxDB query support" ([72234b3](https://github.com/elohmeier/grafana-pi-app/commit/72234b352db90cfd197ee296cb2ce27d54b21325))

# [2.2.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.1.0...v2.2.0) (2026-05-29)

### Features

- add InfluxDB query support ([dd154f4](https://github.com/elohmeier/grafana-pi-app/commit/dd154f46a714d0bda0b625d970bb7283e56e92fd))

# [2.1.0](https://github.com/elohmeier/grafana-pi-app/compare/v2.0.0...v2.1.0) (2026-05-29)

### Features

- add configurable app access ([db4068f](https://github.com/elohmeier/grafana-pi-app/commit/db4068fcfcca259eb056e1aeb0dd5811fc4b2faa))

# [2.0.0](https://github.com/elohmeier/grafana-pi-app/compare/v1.3.0...v2.0.0) (2026-05-29)

- refactor(chat)!: rename Prometheus allowlist ([bacd322](https://github.com/elohmeier/grafana-pi-app/commit/bacd3226188a8a225967f58a21082d60c295765d))

### BREAKING CHANGES

- allowedDatasourceUids is no longer read. Use allowedPrometheusDatasourceUids.

# [1.3.0](https://github.com/elohmeier/grafana-pi-app/compare/v1.2.0...v1.3.0) (2026-05-29)

### Features

- **config:** add system prompt addendum ([30e07fb](https://github.com/elohmeier/grafana-pi-app/commit/30e07fbcddad06eca7e952343a0bfeeaf87eb2e4))
- **skills:** add configurable custom skills ([1b76806](https://github.com/elohmeier/grafana-pi-app/commit/1b76806be3532575b42b1a3ab475f2ccbab66c74))

# [1.2.0](https://github.com/elohmeier/grafana-pi-app/compare/v1.1.0...v1.2.0) (2026-05-29)

### Features

- analysis bench / skills ([cbe2656](https://github.com/elohmeier/grafana-pi-app/commit/cbe265650d484d156b2bc9ff0463fa68934ebce3))
- icons ([4e56110](https://github.com/elohmeier/grafana-pi-app/commit/4e56110278b48675a1326afa7a665ea5987cc357))
- rename & tool rendering & export ([7c33103](https://github.com/elohmeier/grafana-pi-app/commit/7c33103fa7f3db82e769d3a577f73f9b11181ca8))

# [1.1.0](https://github.com/elohmeier/grafana-pi-app/compare/v1.0.1...v1.1.0) (2026-05-28)

### Features

- render ([8afcab5](https://github.com/elohmeier/grafana-pi-app/commit/8afcab5d31fadda81fc71047348ce5dc2440e18d))

## [1.0.1](https://github.com/elohmeier/grafana-pi-app/compare/v1.0.0...v1.0.1) (2026-05-28)

### Bug Fixes

- omit LLM metadata from upstream requests ([0c8091b](https://github.com/elohmeier/grafana-pi-app/commit/0c8091b97601f57e35fb702963dc147b032bc06b))

# 1.0.0 (2026-05-28)

### Features

- add Grafana Pi app ([666cc42](https://github.com/elohmeier/grafana-pi-app/commit/666cc42c064fac195ea45cf0f8429a639359f69d))
- add release publishing ([8cb83da](https://github.com/elohmeier/grafana-pi-app/commit/8cb83dad16e91fae103de45f170fc3ab287ceb35))

# Changelog
