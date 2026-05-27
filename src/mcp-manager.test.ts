import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MCPClient } from './mcp-client.js'
import { MCPManager, MCPServerNotFoundError } from './mcp-manager.js'
import type { MCPClientOptions } from './mcp-client.js'
import type { Tool } from '@noetaris/harness-types'

// Stub factory helpers

function makeStubClient(overrides: {
  url?: string
  command?: string
  options?: MCPClientOptions
  tools?: Tool[]
  discoverImpl?: () => Promise<void>
  disconnectImpl?: () => Promise<void>
}): MCPClient {
  const stub = {
    url: overrides.url,
    command: overrides.command,
    options: overrides.options ?? {},
    transportKind: overrides.url !== undefined ? 'http' : 'stdio',
    tools: vi.fn().mockReturnValue(overrides.tools ?? []),
    discover: overrides.discoverImpl !== undefined
      ? vi.fn().mockImplementation(overrides.discoverImpl)
      : vi.fn().mockResolvedValue(undefined),
    disconnect: overrides.disconnectImpl !== undefined
      ? vi.fn().mockImplementation(overrides.disconnectImpl)
      : vi.fn().mockResolvedValue(undefined),
  }
  return stub as unknown as MCPClient // as: stub is a minimal structural stand-in for MCPClient
}

describe('MCPManager', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  describe('tools() aggregation', () => {

    it('returns flat tool list in client order when tools have distinct names', () => {
      // arrange
      const stubClient1 = makeStubClient({
        url: 'http://s1',
        tools: [{ name: 'read', description: 'r', inputSchema: {} }, { name: 'write', description: 'w', inputSchema: {} }],
      })
      const stubClient2 = makeStubClient({
        url: 'http://s2',
        tools: [{ name: 'list', description: 'l', inputSchema: {} }, { name: 'delete', description: 'd', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient1, stubClient2])

      // act
      const result = manager.tools()

      // assert
      expect(result).toHaveLength(4)
      expect(result[0]!.name).toBe('read')
      expect(result[1]!.name).toBe('write')
      expect(result[2]!.name).toBe('list')
      expect(result[3]!.name).toBe('delete')
    })

    it('last-registered client definition wins when two clients expose the same tool name', () => {
      // arrange
      const stubClient1 = makeStubClient({
        url: 'http://s1',
        tools: [{ name: 'read', description: 'from-client1', inputSchema: {} }],
      })
      const stubClient2 = makeStubClient({
        url: 'http://s2',
        tools: [{ name: 'read', description: 'from-client2', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient1, stubClient2])

      // act
      const result = manager.tools()

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]!.description).toBe('from-client2')
    })

    it('returns empty array when manager has no clients', () => {
      // arrange
      const manager = new MCPManager([])

      // act
      const result = manager.tools()

      // assert
      expect(result).toEqual([])
    })

    it('prefixed clients both appear when their tool names collide before prefixing', () => {
      // arrange
      const stubClient1 = makeStubClient({
        url: 'http://s1',
        options: { prefix: 'fs' },
        tools: [{ name: 'fs/list', description: 'fs list', inputSchema: {} }],
      })
      const stubClient2 = makeStubClient({
        url: 'http://s2',
        options: { prefix: 'gh' },
        tools: [{ name: 'gh/list', description: 'gh list', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient1, stubClient2])

      // act
      const result = manager.tools()

      // assert
      expect(result).toHaveLength(2)
      expect(result.find(t => t.name === 'fs/list')).toBeDefined()
      expect(result.find(t => t.name === 'gh/list')).toBeDefined()
    })

  })

  describe('addServer() — successful addition', () => {

    it('HTTP server tools appear after addServer resolves, appended after existing client tools', async () => {
      // arrange
      const newClient = makeStubClient({
        url: 'http://server2',
        tools: [{ name: 'new-tool', description: '', inputSchema: {} }],
      })
      vi.spyOn(MCPClient, 'fromHttp').mockResolvedValue(newClient)
      const stubClient1 = makeStubClient({
        url: 'http://server1',
        tools: [{ name: 'existing-tool', description: '', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient1])

      // act
      await manager.addServer({ url: 'http://server2' })

      // assert
      const result = manager.tools()
      expect(result).toHaveLength(2)
      expect(result[0]!.name).toBe('existing-tool')
      expect(result[1]!.name).toBe('new-tool')
    })

    it('stdio server tools appear after addServer resolves', async () => {
      // arrange
      const newClient = makeStubClient({
        command: 'npx',
        tools: [{ name: 'stdio-tool', description: '', inputSchema: {} }],
      })
      vi.spyOn(MCPClient, 'fromStdio').mockResolvedValue(newClient)
      const manager = new MCPManager([])

      // act
      await manager.addServer({ command: 'npx', args: ['-y', '@my/mcp'] })

      // assert
      const result = manager.tools()
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('stdio-tool')
    })

    it('tools carry prefix after addServer with prefix option', async () => {
      // arrange
      const newClient = makeStubClient({
        url: 'http://server',
        options: { prefix: 'ns' },
        tools: [{ name: 'ns/tool-a', description: '', inputSchema: {} }],
      })
      vi.spyOn(MCPClient, 'fromHttp').mockResolvedValue(newClient)
      const manager = new MCPManager([])

      // act
      await manager.addServer({ url: 'http://server', prefix: 'ns' })

      // assert
      expect(MCPClient.fromHttp).toHaveBeenCalledWith('http://server', expect.objectContaining({ prefix: 'ns' }))
      const result = manager.tools()
      expect(result[0]!.name).toBe('ns/tool-a')
    })

  })

  describe('addServer() — factory failure', () => {

    it('rejects with factory error and leaves client list unchanged when HTTP factory throws', async () => {
      // arrange
      vi.spyOn(MCPClient, 'fromHttp').mockRejectedValue(new Error('connection refused'))
      const stubClient1 = makeStubClient({
        url: 'http://s1',
        tools: [{ name: 'existing', description: '', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient1])

      // act
      const p = manager.addServer({ url: 'http://unreachable' })

      // assert
      await expect(p).rejects.toThrow('connection refused')
      expect(manager.tools()).toHaveLength(1)
      expect(manager.tools()[0]!.name).toBe('existing')
    })

    it('rejects with factory error and leaves client list unchanged when stdio factory throws', async () => {
      // arrange
      vi.spyOn(MCPClient, 'fromStdio').mockRejectedValue(new Error('spawn ENOENT'))
      const manager = new MCPManager([])

      // act
      const p = manager.addServer({ command: 'no-such-cmd' })

      // assert
      await expect(p).rejects.toThrow('spawn ENOENT')
      expect(manager.tools()).toHaveLength(0)
    })

  })

  describe('removeServer() — successful removal', () => {

    it('removes HTTP client by url and retains other client tools', async () => {
      // arrange
      const stubClient1 = makeStubClient({
        url: 'http://s1',
        tools: [{ name: 's1-tool', description: '', inputSchema: {} }],
      })
      const stubClient2 = makeStubClient({
        url: 'http://s2',
        tools: [{ name: 's2-tool', description: '', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient1, stubClient2])

      // act
      await manager.removeServer('http://s1')

      // assert
      const result = manager.tools()
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('s2-tool')
    })

    it('removes stdio client by command', async () => {
      // arrange
      const stubClient = makeStubClient({
        command: 'npx',
        tools: [{ name: 'npx-tool', description: '', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient])

      // act
      await manager.removeServer('npx')

      // assert
      expect(manager.tools()).toEqual([])
    })

    it('removes only the first match when two stdio clients share the same command key', async () => {
      // arrange
      const stubClient1 = makeStubClient({
        command: 'npx',
        tools: [{ name: 'first-npx-tool', description: '', inputSchema: {} }],
      })
      const stubClient2 = makeStubClient({
        command: 'npx',
        tools: [{ name: 'second-npx-tool', description: '', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient1, stubClient2])

      // act
      await manager.removeServer('npx')

      // assert
      const result = manager.tools()
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('second-npx-tool')
      expect(stubClient1.disconnect).toHaveBeenCalledOnce()
      expect(stubClient2.disconnect).not.toHaveBeenCalled()
    })

  })

  describe('removeServer() — disconnect ordering', () => {

    it('awaits disconnect completion before resolving and before client is removed from tools()', async () => {
      // arrange
      let resolveDisconnect!: () => void
      const disconnectPromise = new Promise<void>(res => { resolveDisconnect = res })
      const stubClient = makeStubClient({
        url: 'http://s1',
        disconnectImpl: () => disconnectPromise,
        tools: [{ name: 's1-tool', description: '', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient])

      // act
      const removePromise = manager.removeServer('http://s1')
      await Promise.resolve()
      expect(manager.tools()).toHaveLength(1)
      resolveDisconnect()
      await removePromise

      // assert
      expect(stubClient.disconnect).toHaveBeenCalledOnce()
      expect(manager.tools()).toEqual([])
    })

  })

  describe('removeServer() — MCPServerNotFoundError', () => {

    it('throws MCPServerNotFoundError with matching key when manager has no clients', async () => {
      // arrange
      const manager = new MCPManager([])

      // act
      const p = manager.removeServer('http://nonexistent')

      // assert
      await expect(p).rejects.toThrow(MCPServerNotFoundError)
      await expect(p).rejects.toMatchObject({ key: 'http://nonexistent' })
    })

    it('throws MCPServerNotFoundError when key does not match any client', async () => {
      // arrange
      const stubClient = makeStubClient({
        url: 'http://s1',
        tools: [],
      })
      const manager = new MCPManager([stubClient])

      // act
      const p = manager.removeServer('http://other')

      // assert
      await expect(p).rejects.toThrow(MCPServerNotFoundError)
      await expect(p).rejects.toMatchObject({ key: 'http://other' })
    })

  })

  describe('bindObserver() and re-discovery', () => {

    it('initiates discover() on all clients when manager has rediscover per-session and clients have no per-client rediscover', () => {
      // arrange
      const stubClient1 = makeStubClient({ options: {}, tools: [{ name: 't1', description: '', inputSchema: {} }] })
      const stubClient2 = makeStubClient({ options: {}, tools: [{ name: 't2', description: '', inputSchema: {} }] })
      const manager = new MCPManager([stubClient1, stubClient2], { rediscover: 'per-session' })

      // act
      manager.bindObserver({})

      // assert
      expect(stubClient1.discover).toHaveBeenCalledOnce()
      expect(stubClient2.discover).toHaveBeenCalledOnce()
    })

    it('tools() returns stale cache during in-flight re-discovery, then fresh after settlement', async () => {
      // arrange
      let resolveDiscover!: () => void
      const discoverPromise = new Promise<void>(res => { resolveDiscover = res })
      const toolsMock = vi.fn().mockReturnValue([{ name: 'stale', description: '', inputSchema: {} }])
      const stubClient = makeStubClient({
        options: {},
        discoverImpl: () => discoverPromise,
        tools: [],
      })
      ;(stubClient.tools as ReturnType<typeof vi.fn>) = toolsMock
      const manager = new MCPManager([stubClient], { rediscover: 'per-session' })

      // act
      manager.bindObserver({})
      const staleBefore = manager.tools()

      toolsMock.mockReturnValue([{ name: 'fresh', description: '', inputSchema: {} }])
      resolveDiscover()
      await discoverPromise

      const freshAfter = manager.tools()

      // assert
      expect(staleBefore[0]!.name).toBe('stale')
      expect(freshAfter[0]!.name).toBe('fresh')
    })

    it('initiates discover() only on the client with per-client rediscover, not on the other', () => {
      // arrange
      const stubClient1 = makeStubClient({ options: { rediscover: 'per-session' }, tools: [] })
      const stubClient2 = makeStubClient({ options: {}, tools: [] })
      const manager = new MCPManager([stubClient1, stubClient2])

      // act
      manager.bindObserver({})

      // assert
      expect(stubClient1.discover).toHaveBeenCalledOnce()
      expect(stubClient2.discover).not.toHaveBeenCalled()
    })

    it('initiates discover() on client when both manager-level and per-client rediscover are set', () => {
      // arrange
      const stubClient = makeStubClient({ options: { rediscover: 'per-session' }, tools: [] })
      const manager = new MCPManager([stubClient], { rediscover: 'per-session' })

      // act
      manager.bindObserver({})

      // assert
      expect(stubClient.discover).toHaveBeenCalledOnce()
    })

    it('fires no discover() calls when no rediscover option is set anywhere', () => {
      // arrange
      const stubClient1 = makeStubClient({ options: {}, tools: [] })
      const stubClient2 = makeStubClient({ options: {}, tools: [] })
      const manager = new MCPManager([stubClient1, stubClient2])

      // act
      manager.bindObserver({})

      // assert
      expect(stubClient1.discover).not.toHaveBeenCalled()
      expect(stubClient2.discover).not.toHaveBeenCalled()
    })

    it('fires discover() even when observer is a NOOP object with no methods', () => {
      // arrange
      const stubClient = makeStubClient({ options: {}, tools: [] })
      const manager = new MCPManager([stubClient], { rediscover: 'per-session' })
      const noopObserver = {}

      // act
      manager.bindObserver(noopObserver)

      // assert
      expect(stubClient.discover).toHaveBeenCalledOnce()
    })

    it('second bindObserver call initiates a new re-discovery', () => {
      // arrange
      const stubClient = makeStubClient({ options: {}, tools: [] })
      const manager = new MCPManager([stubClient], { rediscover: 'per-session' })

      // act
      manager.bindObserver({})
      manager.bindObserver({})

      // assert
      expect(stubClient.discover).toHaveBeenCalledTimes(2)
    })

  })

  describe('construction', () => {

    it('tools() returns aggregated cached tools immediately after construction with no async work', () => {
      // arrange
      const stubClient = makeStubClient({
        tools: [{ name: 't1', description: '', inputSchema: {} }, { name: 't2', description: '', inputSchema: {} }],
      })
      const manager = new MCPManager([stubClient])

      // act
      const result = manager.tools()

      // assert
      expect(result).toHaveLength(2)
      expect(result[0]!.name).toBe('t1')
    })

    it('constructor shallow-copies client list — mutation of original array does not affect manager', () => {
      // arrange
      const stubClient1 = makeStubClient({
        tools: [{ name: 'original', description: '', inputSchema: {} }],
      })
      const clientsArray = [stubClient1]
      const manager = new MCPManager(clientsArray)

      clientsArray.splice(0)

      // act
      const result = manager.tools()

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]!.name).toBe('original')
    })

  })

  describe('addServer() factory dispatch', () => {

    it('dispatches to MCPClient.fromHttp when params contains url field', async () => {
      // arrange
      const stubHttpClient = makeStubClient({ url: 'http://s', tools: [] })
      const stubStdioClient = makeStubClient({ command: 'cmd', tools: [] })
      vi.spyOn(MCPClient, 'fromHttp').mockResolvedValue(stubHttpClient)
      vi.spyOn(MCPClient, 'fromStdio').mockResolvedValue(stubStdioClient)
      const manager = new MCPManager([])

      // act
      await manager.addServer({ url: 'http://s' })

      // assert
      expect(MCPClient.fromHttp).toHaveBeenCalledWith('http://s', expect.any(Object))
      expect(MCPClient.fromStdio).not.toHaveBeenCalled()
    })

    it('dispatches to MCPClient.fromStdio when params contains command field but no url field', async () => {
      // arrange
      const stubHttpClient = makeStubClient({ url: 'http://s', tools: [] })
      const stubStdioClient = makeStubClient({ command: 'my-cmd', tools: [] })
      vi.spyOn(MCPClient, 'fromHttp').mockResolvedValue(stubHttpClient)
      vi.spyOn(MCPClient, 'fromStdio').mockResolvedValue(stubStdioClient)
      const manager = new MCPManager([])

      // act
      await manager.addServer({ command: 'my-cmd', args: ['--flag'] })

      // assert
      expect(MCPClient.fromStdio).toHaveBeenCalledWith(expect.objectContaining({ command: 'my-cmd', args: ['--flag'] }))
      expect(MCPClient.fromHttp).not.toHaveBeenCalled()
    })

  })

})
