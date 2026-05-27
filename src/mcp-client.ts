import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { Tool } from "@noetaris/harness-types"

export interface MCPClientOptions {
  prefix?: string
  rediscover?: "per-session"
}

export class MCPClient {
  readonly url: string
  readonly options: MCPClientOptions

  private _sdk: Client
  private _tools: Tool[] = []

  constructor(url: string, options: MCPClientOptions = {}) {
    this.url = url
    this.options = options
    this._sdk = new Client({ name: "@noetaris/harness-mcp", version: "0.1.0" })
  }

  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.url))
    await this._sdk.connect(transport as Transport)
    await this.discover()
  }

  async discover(): Promise<void> {
    const result = await this._sdk.listTools()
    const prefix = this.options.prefix
    this._tools = result.tools.map(t => ({
      name: prefix !== undefined ? `${prefix}/${t.name}` : t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }))
  }

  tools(): Tool[] {
    return this._tools
  }

  async disconnect(): Promise<void> {
    await this._sdk.close()
  }

  static async from(url: string, options?: MCPClientOptions): Promise<MCPClient> {
    const client = new MCPClient(url, options)
    await client.connect()
    return client
  }
}
