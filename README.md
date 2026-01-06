# @superflag-sh/react

React SDK for [Superflag](https://superflag.sh) feature flags. Works with React, React Native, and Expo.

## Installation

```bash
# npm
npm install @superflag-sh/react

# bun
bun add @superflag-sh/react

# For React Native, also install:
npm install @react-native-async-storage/async-storage
```

## Quick Start

```tsx
import { SuperflagProvider, useFlag, useFlags } from "@superflag-sh/react"

function App() {
  return (
    <SuperflagProvider clientKey="pub_prod_abc123">
      <MyComponent />
    </SuperflagProvider>
  )
}

function MyComponent() {
  const darkMode = useFlag("dark-mode", false)
  const { ready, loading, status } = useFlags()

  if (loading) return <Spinner />

  return <div>{darkMode ? "Dark" : "Light"} mode</div>
}
```

## API

### `<SuperflagProvider>`

Wrap your app with the provider to enable feature flags.

```tsx
<SuperflagProvider
  clientKey="pub_prod_abc123"  // Required (or set EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY)
  ttlSeconds={60}              // Optional, default 60
>
  <App />
</SuperflagProvider>
```

### `useFlag(name, fallback?)`

Get a single flag value.

```tsx
const darkMode = useFlag("dark-mode", false)
const maxUploads = useFlag<number>("max-uploads", 5)
const config = useFlag<{ theme: string }>("app-config")
```

### `useFlags()`

Get the SDK state.

```tsx
const { ready, loading, status } = useFlags()

// status: "idle" | "loading" | "ready" | "error" | "rate-limited"
```

## Environment Variables

The SDK will automatically use `EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY` if no `clientKey` prop is provided.

## Storage

The SDK automatically detects the environment:

- **Web**: Uses `localStorage`
- **React Native**: Uses `@react-native-async-storage/async-storage`
- **Fallback**: In-memory (does not persist)

## Caching

Flags are cached locally and loaded instantly on startup. The SDK refetches when the cache is stale (based on `ttlSeconds`). ETag support ensures minimal bandwidth usage.

## License

MIT
