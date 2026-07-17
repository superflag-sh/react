# Superflag React SDK

This repository is a thin React adapter over `@superflag-sh/core`. It owns network
transport, browser cache/lifecycle behavior, providers, hooks, diagnostics, and
opt-in telemetry integration—not evaluation semantics. In the full workspace, read
`../AGENTS.md`, `../docs/react-sdk.md`, and `../docs/package-compatibility.md` first.

## Adapter boundaries

- Reuse core schema, evaluation, privacy, experiment, inspection, and event behavior.
  Do not create a second evaluator or subtly different fallback semantics.
- Bind persisted caches to schema, endpoint, non-reversible client-key fingerprint,
  app, and environment. Never store raw client keys or reuse a `304` across identities.
- Preserve truthful loading/fresh/stale/error/unauthorized diagnostics. Do not collapse
  a real `false` value into missing/offline state.
- Keep telemetry opt-in, asynchronous, bounded, and independent from evaluation.
  Widen hosted ingestion before releasing a client that emits a new event shape.
- Preserve React 18/19 declarations, browser ESM/CommonJS exports, typed hooks, and
  public export compatibility.

## Verification and release

Run focused tests first, then:

```bash
bun run release:check
```

The release gate includes cache-drift and packed-consumer checks. Use
`bun run smoke:registry` only after an authorized exact-version publication and prove
the consumer did not resolve local workspace artifacts. The required core version
must already exist in the registry. Do not commit, push, publish, or tag without
explicit approval.
