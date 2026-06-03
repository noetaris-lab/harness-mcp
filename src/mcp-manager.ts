import { watch as fsWatch } from 'node:fs'
import { resolve } from 'node:path'
import type { Tool } from '@noetaris/harness-types'
import { MCPClient, type MCPClientOptions, type MCPStdioParams } from './mcp-client.js'
import { loadMCPConfig } from './mcp-config-loader.js'

export interface MCPManagerOptions {
  rediscover?: 'per-session'
}

export interface MCPWatchOptions {
  onError?: (err: Error) => void
}

export interface MCPHttpParams extends MCPClientOptions {
  url: string
  headers?: Record<string, string>
}

type LocalObserver = {
  onRunStart?:  (...args: unknown[]) => void
  onRunEnd?:    (...args: unknown[]) => void
  onStepStart?: (...args: unknown[]) => void
  onStepEnd?:   (...args: unknown[]) => void
  onStepError?: (...args: unknown[]) => void
  onInterrupt?: (...args: unknown[]) => void
  onEvent?:     (...args: unknown[]) => void
}

export class MCPServerNotFoundError extends Error {
  readonly key: string
  constructor(key: string) {
    super(`no MCP server registered with key: ${key}`)
    this.name = 'MCPServerNotFoundError'
    this.key = key
  }
}

export class MCPManager {
  private clients: MCPClient[]
  private readonly options: MCPManagerOptions

  constructor(clients: MCPClient[], options: MCPManagerOptions = {}) {
    this.clients = [...clients]
    this.options = options
  }

  tools(): Tool[] {
    const map = new Map<string, Tool>()
    for (const client of this.clients) {
      for (const tool of client.tools()) {
        map.set(tool.name, tool)
      }
    }
    return [...map.values()]
  }

  async addServer(params: MCPHttpParams | MCPStdioParams): Promise<void> {
    let client: MCPClient
    if ('url' in params) {
      const { url, ...clientOptions } = params
      client = await MCPClient.fromHttp(url, clientOptions)
    } else {
      client = await MCPClient.fromStdio(params)
    }
    this.clients.push(client)
  }

  async removeServer(key: string): Promise<void> {
    const index = this.clients.findIndex(c => c.url === key || c.command === key)
    if (index === -1) {
      throw new MCPServerNotFoundError(key)
    }
    // noUncheckedIndexedAccess: index is validated above so the value is defined
    const client = this.clients[index]!
    await client.disconnect()
    this.clients.splice(index, 1)
  }

  bindObserver(_observer: LocalObserver): void {
    const applicable = this.clients.filter(c => this.shouldRediscover(c))
    if (applicable.length > 0) {
      void Promise.all(applicable.map(c => c.discover()))
    }
  }

  async loadConfig(path: string): Promise<void> {
    const entries = await loadMCPConfig(path)
    for (const entry of entries) {
      await this.addServer(entry)
    }
  }

  async watch(path: string, options?: MCPWatchOptions): Promise<() => Promise<void>> {
    const resolvedPath = resolve(path)
    const onError = options?.onError
    let disposed = false
    let debounceTimer: ReturnType<typeof setTimeout> | undefined

    const reload = async (): Promise<void> => {
      let entries: Array<MCPHttpParams | MCPStdioParams>
      try {
        entries = await loadMCPConfig(resolvedPath)
      } catch (err) {
        onError?.(err as Error) // as: caught value is typed unknown; caller expects Error
        return
      }

      const currentKeys = new Set(this.clients.map(c => c.url ?? c.command ?? ''))
      const newKeys = new Set(entries.map(e => ('url' in e ? e.url : e.command) ?? ''))

      // entries whose key is not in current set, OR whose key is present but options differ
      const toAdd = entries.filter(e => {
        const key = ('url' in e ? e.url : e.command) ?? ''
        if (!currentKeys.has(key)) return true
        const existing = this.clients.find(c => (c.url ?? c.command) === key)
        if (existing === undefined) return true
        // compare prefix option: if different, treat as replace
        const existingPrefix = existing.options.prefix
        const newPrefix = e.prefix
        return existingPrefix !== newPrefix
      })
      // keys to remove: not in new set, OR same key but options differ (matched toAdd key)
      const toAddKeys = new Set(toAdd.map(e => ('url' in e ? e.url : e.command) ?? ''))
      const toRemoveKeys = [...currentKeys].filter(k => !newKeys.has(k) || toAddKeys.has(k))

      const addedKeys: string[] = []
      try {
        for (const entry of toAdd) {
          await this.addServer(entry)
          addedKeys.push(('url' in entry ? entry.url : entry.command) ?? '')
        }
      } catch (err) {
        // rollback successfully added servers in reverse order; swallow rollback errors to ensure onError is always called
        for (let i = addedKeys.length - 1; i >= 0; i--) {
          try { await this.removeServer(addedKeys[i]!) } catch { /* swallow: rollback best-effort; onError called below */ }
        }
        onError?.(err as Error) // as: caught value is typed unknown; caller expects Error
        return
      }

      for (const key of toRemoveKeys) {
        try {
          await this.removeServer(key)
        } catch (err) {
          onError?.(err as Error) // as: caught value is typed unknown; caller expects Error
          return
        }
      }
    }

    const watcher = fsWatch(resolvedPath)

    watcher.on('change', () => {
      if (disposed) return
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        void reload()
      }, 100)
    })

    watcher.on('error', (err: Error) => {
      disposed = true
      clearTimeout(debounceTimer)
      watcher.close()
      onError?.(err)
    })

    return (): Promise<void> => {
      if (!disposed) {
        disposed = true
        clearTimeout(debounceTimer)
        watcher.close()
      }
      return Promise.resolve()
    }
  }

  static async fromConfig(path: string): Promise<MCPManager> {
    const manager = new MCPManager([])
    await manager.loadConfig(path)
    return manager
  }

  private shouldRediscover(client: MCPClient): boolean {
    if (client.options.rediscover === 'per-session') return true
    if (client.options.rediscover === undefined && this.options.rediscover === 'per-session') return true
    return false
  }
}
