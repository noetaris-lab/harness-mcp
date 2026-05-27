import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { Tool } from "@noetaris/harness-types"

export interface MCPClientOptions {
  prefix?: string
  rediscover?: "per-session"
}

export interface MCPStdioParams extends MCPClientOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
}

type TransportKind = "http" | "stdio"

export class MCPClient {
  readonly url: string | undefined
  readonly command: string | undefined
  readonly options: MCPClientOptions
  readonly transportKind: TransportKind

  private sdk: Client
  private cachedTools: Tool[] = []

  private constructor(
    transportKind: TransportKind,
    options: MCPClientOptions,
    url?: string,
    command?: string,
  ) {
    this.transportKind = transportKind
    this.options = options
    this.url = url
    this.command = command
    this.sdk = new Client({ name: "@noetaris/harness-mcp", version: "0.1.0" })
  }

  static async fromHttp(url: string, options: MCPClientOptions = {}): Promise<MCPClient> {
    const client = new MCPClient("http", options, url, undefined)
    const transport = new StreamableHTTPClientTransport(new URL(url))
    await client.sdk.connect(transport as Transport) // as: StreamableHTTPClientTransport implements Transport but the SDK typings don't extend the base interface directly
    await client.discover()
    return client
  }

  static async fromStdio(params: MCPStdioParams): Promise<MCPClient> {
    const { command, args, env, ...options } = params
    const client = new MCPClient("stdio", options, undefined, command)
    const stdioParams = { command, ...(args !== undefined && { args }), ...(env !== undefined && { env }) }
    const transport = new StdioClientTransport(stdioParams)
    await client.sdk.connect(transport as Transport) // as: StdioClientTransport implements Transport but the SDK typings don't extend the base interface directly
    await client.discover()
    return client
  }

  async discover(): Promise<void> {
    const result = await this.sdk.listTools()
    const prefix = this.options.prefix
    this.cachedTools = result.tools.map(t => ({
      name: prefix !== undefined ? `${prefix}/${t.name}` : t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>, // as: MCP SDK types inputSchema as a specific JSON Schema type; harness Tool uses the wider Record<string, unknown>
    }))
  }

  tools(): Tool[] {
    return this.cachedTools
  }

  async disconnect(): Promise<void> {
    await this.sdk.close()
  }
}
