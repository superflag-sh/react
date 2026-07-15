# @superflag-sh/react

React/web adapter for Superflag feature flags. Evaluation, validation, targeting, and generated flag types come from `@superflag-sh/core`; this package owns React hooks plus browser fetch, cache, and lifecycle behavior.

## Installation

```bash
npm install @superflag-sh/react
# or
bun add @superflag-sh/react
```

`@superflag-sh/core` is installed as a normal runtime dependency.

## Quick start

```tsx
import { SuperflagProvider, useBooleanFlag, useFlags } from "@superflag-sh/react"

function App() {
  return (
    <SuperflagProvider
      clientKey="pub_prod_abc123"
      targetingKey="user-123"
      attributes={{ plan: "pro", country: "US" }}
      ttlSeconds={60}
      maxStaleAgeSeconds={86_400}
    >
      <Checkout />
    </SuperflagProvider>
  )
}

function Checkout() {
  const enabled = useBooleanFlag("checkout", false)
  const { ready, stale, source, age, refresh } = useFlags()

  if (!ready) return null
  return (
    <button disabled={!enabled || stale} onClick={() => void refresh()}>
      Checkout ({source}, {age?.toFixed(1)}s old)
    </button>
  )
}
```

`userId` remains supported as a deprecated alias for `targetingKey`. New integrations should pass `targetingKey` and optional JSON-compatible `attributes`. An absent identity always fails closed to the typed fallback; it never expands a rollout.

## Provider

```tsx
<SuperflagProvider
  clientKey="pub_prod_abc123"
  configUrl="https://superflag.sh/api/v1/public-config"
  targetingKey="user-123"
  attributes={{ plan: "pro" }}
  ttlSeconds={60}                 // fresh lifetime
  maxStaleAgeSeconds={86_400}     // hard serving limit; default 24 hours
  maxRetries={2}                  // retries after the initial request
  retryBaseDelayMs={250}
  retryMaxDelayMs={5_000}
  storage={customStorage}
  onReady={(info) => {}}
  onDiagnostic={(diagnostic) => {}}
  onEvaluation={(event) => {}}
  onExposure={(event) => {}}
  telemetry={{ hosted: true }}
>
  <App />
</SuperflagProvider>
```

The provider serves an identity-bound cache immediately when it is within `maxStaleAgeSeconds`, then revalidates it with an ETag. Once `ttlSeconds` elapses, the state is truthfully marked stale while revalidation runs. Successful `304` responses renew `fetchedAt`; failures preserve cached values only until the configured hard stale limit.

Refreshes are deduplicated, retry transient network/408/425/429/5xx failures with bounded exponential backoff, and run automatically on TTL expiry, `visibilitychange` to visible, and browser `online`. Unmount removes timers/listeners and aborts in-flight work.

Consumer callbacks are isolated from SDK behavior. Evaluation and exposure events contain no targeting key, attributes, or client key.
`onEvaluation` retains fallback/error visibility, while `onExposure` runs only
for a successfully resolved remote or cached variation. Provider initialization,
detail reads, and `useFlags()` never create false exposures.

Value hooks and `getFlag` emit one exposure carrying the decision provenance.
Explicit detail/inspection reads emit one decision instead. The SDK deliberately
does not emit a paired decision plus exposure for the same value read, which
would double-count ordinary feature use.

## Feature telemetry and outcomes

Canonical decision, exposure, and numeric outcome telemetry is opt-in. Hosted
delivery must be explicitly enabled; otherwise supply a custom transport or use
callback-only mode.

```tsx
<SuperflagProvider
  clientKey="pub_prod_abc123"
  targetingKey="user-123"
  telemetry={{
    hosted: true,
    maxQueueSize: 1_000,
    batchSize: 50,
    allowedAttributes: ["plan", "country"],
    onDiagnostic: (diagnostic) => console.warn(diagnostic),
  }}
>
  <App />
</SuperflagProvider>
```

`hosted: true` posts versioned batches to `/api/v1/events/batch` on the
configured control-plane origin. Use `hosted: { baseUrl }` for a separate
control-plane URL or `transport` for a fully custom `TelemetryTransport`.
Evaluation never waits on telemetry. The core queue is bounded, batched,
deduplicates exposures, retries transient item failures with backoff, and reports
all delivery failures through fail-open diagnostics.

The default browser identity projection combines a random installation key with
the application/environment namespace to create a non-reversible pseudonym
before enqueueing an event. Only the random key is persisted; raw targeting
keys, targeting attributes, flag values, and client keys are not event fields or
storage values. Applications that need account-level identity across devices or
own a rotation/consent boundary can provide `pseudonymize`; it may be async and
receives the raw targeting key only inside that explicit hook.

Record a numeric feature outcome through the imperative client after the subject
has actually read the flag value:

```tsx
function PurchaseButton() {
  const checkout = useBooleanFlag("checkout", false)
  const flags = useSuperflagClient<{ checkout: boolean }>()

  async function purchased(revenue: number) {
    await flags.track("checkout", "revenue", revenue, {
      revision: 1,
      attributes: { plan: "pro", country: "US" },
    })
  }

  return <button disabled={!checkout} onClick={() => void purchased(19)}>Buy</button>
}
```

`track` is intentionally feature-scoped, numeric, and tied to the current
subject's latest real exposure. It rejects missing exposures and non-finite
values, and copies only attributes named by `allowedAttributes`. The client also
exposes `flush()` and `shutdown()`; the provider opportunistically flushes when
the page is hidden, on `pagehide`, and when the browser returns online. Unmount
performs a bounded best-effort shutdown without blocking React cleanup.

## Flag hooks

`useFlag` is preserved for compatibility:

```tsx
const enabled = useFlag("checkout", false)
const title = useFlag("checkout-title", "Buy now")
```

Prefer the explicitly typed hooks for new code:

```tsx
const enabled = useBooleanFlag("checkout", false)
const title = useStringFlag("checkout-title", "Buy now")
const limit = useNumberFlag("upload-limit", 5)
const layout = useObjectFlag("layout", { density: "comfortable" })
```

Every value hook has a detail counterpart: `useFlagDetails`, `useBooleanFlagDetails`, `useStringFlagDetails`, `useNumberFlagDetails`, and `useObjectFlagDetails`.

```tsx
const detail = useBooleanFlagDetails("checkout", false)
// {
//   value, variation, reason, ruleId, segmentIds,
//   source, configVersion, errorCode, errorMessage, timestamp, ...
// }
```

Wrong remote types return the supplied typed fallback and emit a `TYPE_MISMATCH` diagnostic.

### Generated flag maps

Bind the value map generated by `@superflag-sh/core` once to reject unknown keys and incorrect fallback types:

```tsx
import { createTypedHooks } from "@superflag-sh/react"
import type { SuperflagFlagValues } from "./superflag.generated"

const flags = createTypedHooks<SuperflagFlagValues>()

function Checkout() {
  const enabled = flags.useFlag("checkout", false)
  const detail = flags.useFlagDetails("checkout", false)
  return enabled ? <span>{detail.reason}</span> : null
}
```

`createTypedHooks<typeof config>()` also accepts a literal core `FlagConfig`.
The returned `useClient()` hook provides typed imperative `getFlag`,
`getFlagDetails`, and `refresh` methods for event handlers. An unbound
`useSuperflagClient<SuperflagFlagValues>()` export is also available.

## State and refresh

`useFlags()` exposes:

- `status`: `idle | loading | refreshing | ready | stale | error | rate-limited`
- `source`: `cache | network | default`
- `error`, `fetchedAt`, `configVersion`, `age`, and `stale`
- compatibility aliases `lastFetchedAt` and `version`
- `ready`, `loading`, and the deduplicated async `refresh()` function
- `appId` and `environment` for the validated cache identity

`source: "default"` means no remote/cache config is currently being served. Safety-sensitive UI should gate on `ready` and may additionally reject `stale` data.

## Core config and legacy payloads

New responses use the versioned `FlagConfig` from `@superflag-sh/core`, including named variations, explicit enabled/off/fallthrough behavior, source identity, and config version. The SDK validates every network and cache boundary before evaluation.

For migration, the current legacy `{ type, value, rollout, variants }` response is converted only at the boundary with core's `migrateLegacyFlags` adapter. Evaluation itself is never duplicated in this package.

## Storage

```ts
interface StorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}
```

The default adapter uses `localStorage` when available and otherwise falls back to session memory. Cache entries are schema-versioned and partitioned by endpoint plus a SHA-256 client-key fingerprint; raw client keys are never persisted. App/environment identity must match before an ETag or cached config can be reused.

## Package targets

The package ships browser ESM, CommonJS, and one declaration tree. Release checks run core conformance vectors, lifecycle/cache tests, type checking, the shared cache-drift gate, and packed-tarball ESM/CommonJS/NodeNext consumer smoke tests.

## License

MIT
