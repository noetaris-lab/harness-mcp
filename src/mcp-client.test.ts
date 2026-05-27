import { describe, it, expect, vi, beforeEach } from "vitest"
import { MCPClient } from "./mcp-client.js"

// Mocks are declared at module scope; individual test groups override as needed
let mockConnect = vi.fn().mockResolvedValue(undefined)
let mockClose = vi.fn().mockResolvedValue(undefined)
let mockListTools = vi.fn().mockResolvedValue({ tools: [] })
let stdioCtorSpy = vi.fn()

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    get connect() { return mockConnect }
    get close() { return mockClose }
    get listTools() { return mockListTools }
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

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(params: unknown) { stdioCtorSpy(params) }
    start = vi.fn()
    close = vi.fn()
    send = vi.fn()
  },
}))

beforeEach(() => {
  mockConnect = vi.fn().mockResolvedValue(undefined)
  mockClose = vi.fn().mockResolvedValue(undefined)
  mockListTools = vi.fn().mockResolvedValue({ tools: [] })
  stdioCtorSpy = vi.fn()
})

describe("MCPClient", () => {

  describe("fromHttp — instance fields and transport identity", () => {

    it("sets transportKind='http', url to the given URL, and command to undefined when called with a valid URL", async () => {
      // arrange
      mockListTools.mockResolvedValue({ tools: [] })

      // act
      const client = await MCPClient.fromHttp("http://localhost:3001")

      // assert
      expect(client.transportKind).toBe("http")
      expect(client.url).toBe("http://localhost:3001")
      expect(client.command).toBeUndefined()
    })

    it("returns tools already discovered (no prefix) when fromHttp completes without options", async () => {
      // arrange
      mockListTools.mockResolvedValue({
        tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
      })

      // act
      const client = await MCPClient.fromHttp("http://localhost:3001")

      // assert
      expect(client.tools()).toHaveLength(1)
      expect(client.tools()[0]?.name).toBe("read_file")
    })

  })

  describe("fromHttp — options handling", () => {

    it("prefixes tool names with '<prefix>/' when options.prefix is given", async () => {
      // arrange
      mockListTools.mockResolvedValue({
        tools: [
          { name: "read_file", description: "", inputSchema: {} },
          { name: "write_file", description: "", inputSchema: {} },
        ],
      })

      // act
      const client = await MCPClient.fromHttp("http://localhost:3001", { prefix: "fs" })

      // assert
      expect(client.tools()[0]?.name).toBe("fs/read_file")
      expect(client.tools()[1]?.name).toBe("fs/write_file")
    })

    it("stores options.rediscover on the returned client when fromHttp is called with { rediscover: 'per-session' }", async () => {
      // arrange
      mockListTools.mockResolvedValue({ tools: [] })

      // act
      const client = await MCPClient.fromHttp("http://localhost:3001", { rediscover: "per-session" })

      // assert
      expect(client.options.rediscover).toBe("per-session")
    })

  })

  describe("fromHttp — error propagation", () => {

    it("rejects with the SDK error when the server is unreachable", async () => {
      // arrange
      mockConnect = vi.fn().mockRejectedValue(new Error("Connection refused"))

      // act / assert
      await expect(MCPClient.fromHttp("http://unreachable:9999")).rejects.toThrow("Connection refused")
    })

  })

  describe("fromStdio — instance fields and transport identity", () => {

    it("sets transportKind='stdio', command to the given command, and url to undefined when called with minimal params", async () => {
      // arrange
      mockListTools.mockResolvedValue({ tools: [] })

      // act
      const client = await MCPClient.fromStdio({ command: "npx" })

      // assert
      expect(client.transportKind).toBe("stdio")
      expect(client.command).toBe("npx")
      expect(client.url).toBeUndefined()
    })

    it("returns tools already discovered when fromStdio completes with minimal params", async () => {
      // arrange
      mockListTools.mockResolvedValue({
        tools: [{ name: "run_cmd", description: "Run a command", inputSchema: { type: "object" } }],
      })

      // act
      const client = await MCPClient.fromStdio({ command: "npx" })

      // assert
      expect(client.tools()).toHaveLength(1)
      expect(client.tools()[0]?.name).toBe("run_cmd")
    })

  })

  describe("fromStdio — parameter forwarding", () => {

    it("forwards command, args, and env to StdioClientTransport constructor when all three params are provided", async () => {
      // arrange
      mockListTools.mockResolvedValue({ tools: [] })

      // act
      await MCPClient.fromStdio({ command: "npx", args: ["-y", "@my/server"], env: { TOKEN: "abc" } })

      // assert
      expect(stdioCtorSpy).toHaveBeenCalledOnce()
      expect(stdioCtorSpy).toHaveBeenCalledWith({ command: "npx", args: ["-y", "@my/server"], env: { TOKEN: "abc" } })
    })

  })

  describe("fromStdio — options handling and error propagation", () => {

    it("prefixes tool names with '<prefix>/' when params.prefix is given", async () => {
      // arrange
      mockListTools.mockResolvedValue({
        tools: [{ name: "do_thing", description: "", inputSchema: {} }],
      })

      // act
      const client = await MCPClient.fromStdio({ command: "npx", prefix: "custom" })

      // assert
      expect(client.tools()[0]?.name).toBe("custom/do_thing")
    })

    it("rejects with the SDK error when the subprocess cannot be spawned", async () => {
      // arrange
      mockConnect = vi.fn().mockRejectedValue(new Error("spawn ENOENT"))

      // act / assert
      await expect(MCPClient.fromStdio({ command: "nonexistent-binary" })).rejects.toThrow("spawn ENOENT")
    })

  })

  describe("disconnect()", () => {

    it("calls sdk.close() when disconnecting an HTTP client", async () => {
      // arrange
      mockListTools.mockResolvedValue({ tools: [] })
      const closeSpy = vi.fn().mockResolvedValue(undefined)
      mockClose = closeSpy
      const client = await MCPClient.fromHttp("http://localhost:3001")

      // act
      await client.disconnect()

      // assert
      expect(closeSpy).toHaveBeenCalledOnce()
    })

    it("calls sdk.close() when disconnecting a stdio client", async () => {
      // arrange
      mockListTools.mockResolvedValue({ tools: [] })
      const closeSpy = vi.fn().mockResolvedValue(undefined)
      mockClose = closeSpy
      const client = await MCPClient.fromStdio({ command: "npx" })

      // act
      await client.disconnect()

      // assert
      expect(closeSpy).toHaveBeenCalledOnce()
    })

  })

  describe("discover() and tools() contract", () => {

    it("tools() returns the new list when discover() is called after the client is already connected", async () => {
      // arrange
      mockListTools
        .mockResolvedValueOnce({ tools: [{ name: "alpha", description: "", inputSchema: {} }] })
        .mockResolvedValueOnce({ tools: [{ name: "beta", description: "", inputSchema: {} }] })
      const client = await MCPClient.fromHttp("http://localhost:3001")

      // act
      await client.discover()

      // assert
      expect(client.tools()).toHaveLength(1)
      expect(client.tools()[0]?.name).toBe("beta")
    })

    it("replaces the old list entirely (no stale entries) when discover() is called a second time with a prefix active", async () => {
      // arrange
      mockListTools
        .mockResolvedValueOnce({ tools: [{ name: "old_tool", description: "", inputSchema: {} }] })
        .mockResolvedValueOnce({ tools: [{ name: "new_tool", description: "", inputSchema: {} }] })
      const client = await MCPClient.fromHttp("http://localhost:3001", { prefix: "svc" })

      // act
      await client.discover()

      // assert
      expect(client.tools()).toHaveLength(1)
      expect(client.tools()[0]?.name).toBe("svc/new_tool")
      expect(client.tools().find(t => t.name === "svc/old_tool")).toBeUndefined()
    })

    it("tools() returns [] when the server exposes no tools", async () => {
      // arrange
      mockListTools.mockResolvedValue({ tools: [] })

      // act
      const client = await MCPClient.fromHttp("http://localhost:3001")

      // assert
      expect(client.tools()).toEqual([])
    })

    it("tools() returns a stable array reference when called multiple times between discover() calls", async () => {
      // arrange
      mockListTools.mockResolvedValue({
        tools: [{ name: "tool_a", description: "", inputSchema: {} }],
      })
      const client = await MCPClient.fromHttp("http://localhost:3001")

      // act
      const ref1 = client.tools()
      const ref2 = client.tools()

      // assert
      expect(ref1).toBe(ref2)
    })

  })

})
