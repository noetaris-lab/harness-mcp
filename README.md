# @noetaris/harness-mcp

MCP (Model Context Protocol) client integration for [@noetaris/harness](https://github.com/noetaris-lab/harness). Connect your agents to MCP servers over HTTP or stdio and expose their tools directly to the harness tool-calling pipeline.

## Overview

`@noetaris/harness-mcp` provides two main building blocks:

- **`MCPClient`** — connects to a single MCP server (HTTP or stdio), discovers its tools, and exposes them as `Tool[]` compatible with the harness tool schema
- **`MCPManager`** — manages a pool of `MCPClient` instances, merges their tool lists, and supports live config reload via file watching

Config files (`.json`, `.ts`, `.js`, `.mjs`) can be loaded with `MCPManager.fromConfig()` or watched for changes with `MCPManager.watch()`.

## Installation

```bash
pnpm add @noetaris/harness-mcp
```

Peer dependency:

```bash
pnpm add @noetaris/harness-types
```

## Quick Start

```typescript
import { MCPClient, MCPManager } from '@noetaris/harness-mcp'

// single HTTP server
const client = await MCPClient.fromHttp('http://localhost:3100/mcp')
console.log(client.tools()) // Tool[]

// multiple servers via manager
const manager = new MCPManager([client])
await manager.addServer({ command: 'npx', args: ['my-mcp-server'] })
console.log(manager.tools()) // merged Tool[] — last-write-wins on duplicate names
```

## API Reference

### `MCPClient`

Wraps a single MCP server connection. Use the static factory methods to create instances; the constructor is private.

#### `MCPClient.fromHttp(url, options?): Promise<MCPClient>`

Connects to an MCP server over Streamable HTTP and discovers its tools.

```typescript
const client = await MCPClient.fromHttp('http://localhost:3100/mcp', {
  prefix: 'search',     // optional: prefix all tool names with "search/"
  rediscover: 'per-session', // optional: re-run tool discovery on each harness session start
})
```

| Option | Type | Description |
|--------|------|-------------|
| `prefix` | `string` | Prepended to all tool names as `{prefix}/{name}`. Useful to namespace tools from different servers. |
| `rediscover` | `"per-session"` | Re-discovers tools at the start of each harness run (via `bindObserver`). Omit for static tool lists. |

#### `MCPClient.fromStdio(params): Promise<MCPClient>`

Launches a subprocess and connects to it over stdio.

```typescript
const client = await MCPClient.fromStdio({
  command: 'npx',
  args: ['@acme/mcp-server', '--port', '0'],
  env: { API_KEY: process.env.API_KEY! },
  prefix: 'acme',
})
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | `string` | The executable to run. |
| `args` | `string[]` | Arguments passed to the command. |
| `env` | `Record<string, string>` | Environment variables for the subprocess. |
| `prefix` | `string` | Tool name prefix (same as HTTP). |
| `rediscover` | `"per-session"` | Per-session rediscovery (same as HTTP). |

#### `client.tools(): Tool[]`

Returns the cached tool list from the last `discover()` call.

#### `client.discover(): Promise<void>`

Re-queries the server for its tool list and updates the cache. Called automatically on construction; call manually to refresh.

#### `client.disconnect(): Promise<void>`

Closes the underlying transport. Always call this when the client is no longer needed to avoid resource leaks.

---

### `MCPManager`

Manages a pool of `MCPClient` instances. Tool name conflicts are resolved last-write-wins (later clients in the pool overwrite earlier ones for the same tool name).

#### `new MCPManager(clients, options?)`

```typescript
const manager = new MCPManager([clientA, clientB], {
  rediscover: 'per-session', // applies to all clients that don't set their own rediscover option
})
```

#### `manager.tools(): Tool[]`

Returns the merged tool list across all connected servers.

#### `manager.addServer(params): Promise<void>`

Connects to a new server and adds it to the pool. Accepts the same parameters as `MCPClient.fromHttp` (pass `{ url: '...' }`) or `MCPClient.fromStdio` (pass `{ command: '...' }`).

```typescript
await manager.addServer({ url: 'http://localhost:3200/mcp', prefix: 'tools' })
await manager.addServer({ command: 'my-mcp-server', prefix: 'local' })
```

#### `manager.removeServer(key): Promise<void>`

Disconnects and removes a server by its URL (HTTP) or command (stdio). Throws `MCPServerNotFoundError` if no server matches the key.

```typescript
await manager.removeServer('http://localhost:3200/mcp')
await manager.removeServer('my-mcp-server')
```

#### `manager.loadConfig(path): Promise<void>`

Loads server definitions from a config file and adds each as a new server. See [Config File Format](#config-file-format) below.

#### `manager.watch(path, options?): Promise<() => Promise<void>>`

Watches a config file for changes and hot-reloads servers. Changes are debounced by 100ms. Returns a `dispose` function to stop watching.

```typescript
const stopWatching = await manager.watch('./mcp.config.json', {
  onError: (err) => console.error('MCP reload error:', err),
})

// later
await stopWatching()
```

If a reload fails to add a new server, previously added servers from that reload batch are rolled back before `onError` is called.

#### `manager.bindObserver(observer): void`

Binds the manager to a harness observer. Clients configured with `rediscover: 'per-session'` will call `discover()` at the start of each harness run. Pass the observer you register with `harness.addObserver()`.

```typescript
const manager = new MCPManager([client], { rediscover: 'per-session' })
harness.addObserver(manager.bindObserver.bind(manager))
```

#### `MCPManager.fromConfig(path): Promise<MCPManager>`

Static factory. Creates a new manager and loads servers from a config file in one step.

```typescript
const manager = await MCPManager.fromConfig('./mcp.config.json')
```

---

### Config File Format

Config files can be `.json`, `.ts`, `.js`, or `.mjs`. The schema is:

```typescript
interface MCPConfigSchema {
  servers: MCPServerEntry[]
}
```

**JSON example:**

```json
{
  "servers": [
    { "url": "http://localhost:3100/mcp", "prefix": "search" },
    {
      "transport": "stdio",
      "command": "npx",
      "args": ["@acme/mcp-server"],
      "env": { "API_KEY": "secret" },
      "prefix": "acme",
      "rediscover": "per-session"
    }
  ]
}
```

**TypeScript example (`mcp.config.ts`):**

```typescript
export default {
  servers: [
    { url: 'http://localhost:3100/mcp' },
    { transport: 'stdio' as const, command: 'my-server' },
  ],
}
```

HTTP entries default to `transport: 'http'` and require a `url` field. Stdio entries require `transport: 'stdio'` and a `command` field. Both support optional `prefix` and `rediscover` fields.

---

### Error Classes

#### `MCPServerNotFoundError`

Thrown by `removeServer()` when no client matches the given key.

```typescript
import { MCPServerNotFoundError } from '@noetaris/harness-mcp'

try {
  await manager.removeServer('http://gone.invalid')
} catch (err) {
  if (err instanceof MCPServerNotFoundError) {
    console.error(err.key) // 'http://gone.invalid'
  }
}
```

#### `MCPConfigParseError`

Thrown by `loadConfig()` and `watch()` when the config file is structurally invalid.

```typescript
import { MCPConfigParseError } from '@noetaris/harness-mcp'

try {
  await manager.loadConfig('./bad-config.json')
} catch (err) {
  if (err instanceof MCPConfigParseError) {
    console.error(err.path)   // file path
    console.error(err.detail) // what was wrong
  }
}
```

#### `MCPConfigExtensionError`

Thrown when the config file has an unsupported extension.

```typescript
import { MCPConfigExtensionError } from '@noetaris/harness-mcp'
```

## License

MIT
