import type { Tool } from '@noetaris/harness-types'
import { MCPClient, type MCPClientOptions, type MCPStdioParams } from './mcp-client.js'

export interface MCPManagerOptions {
  rediscover?: 'per-session'
}

export interface MCPHttpParams extends MCPClientOptions {
  url: string
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

  private shouldRediscover(client: MCPClient): boolean {
    if (client.options.rediscover === 'per-session') return true
    if (client.options.rediscover === undefined && this.options.rediscover === 'per-session') return true
    return false
  }
}
