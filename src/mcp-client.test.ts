import { describe, it, expect, vi } from "vitest"
import { MCPClient } from "./mcp-client.js"

const mockListTools = vi.fn().mockResolvedValue({
  tools: [
    { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
    { name: "write_file", description: "Write a file", inputSchema: { type: "object" } },
  ],
})

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    listTools = mockListTools
  },
}))

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    sessionId: string | undefined = undefined
    start = vi.fn()
    close = vi.fn()
    send = vi.fn()
  },
}))

describe("MCPClient prefix option", () => {
  it("leaves tool names unchanged when no prefix is set", async () => {
    const client = new MCPClient("http://localhost:3000")
    await client.connect()
    const tools = client.tools()
    expect(tools[0]?.name).toBe("read_file")
    expect(tools[1]?.name).toBe("write_file")
  })

  it("prepends prefix/ to each tool name", async () => {
    const client = new MCPClient("http://localhost:3000", { prefix: "fs" })
    await client.connect()
    const tools = client.tools()
    expect(tools[0]?.name).toBe("fs/read_file")
    expect(tools[1]?.name).toBe("fs/write_file")
  })
})
