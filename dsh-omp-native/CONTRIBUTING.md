# Contributing

Thanks for helping with `dsh-omp-native`. This is a small, single-crate
repository; keep it that way.

## Ground rules

- **No new runtime dependencies beyond the pinned set.** The crate builds on
  the stable channel (edition 2024) — never depend on nightly-only crates
  (the `xutf` → `unicode-width` swap is the precedent).
- **Preserve the per-file upstream attribution headers**
  (`Ported from omp² ...` — MIT, see `THIRD-PARTY-NOTICES.md`).
- **Bounded read-only surface.** Every new subcommand must enforce the omp²
  ceilings, emit one JSON document on stdout per `docs/cli-contract.md`, and
  refuse writes.
- **Stay pinned to the fork.** This repo mirrors
  `native/dsh-omp-native` in the [hy-sde deepseek-harness fork](https://github.com/hy-sde/deepseek-harness);
  when the fork's sidecar evolves, bring the change here too (and vice versa).
- Keep the EN/zh README pair consistent and re-record `README.i18n.yaml`
  hashes after editing either side.

## Development

```sh
cargo build --release   # stable channel, statically linked
cargo test --release    # sqlite module unit tests
cargo clippy --release  # lints
```

## Contract

The external JSON CLI contract is pinned in `docs/cli-contract.md`. Any change
to the input syntax or the output shape must update that document in the same
commit.
