import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MCPClient } from './mcp-client.js'
import { MCPManager, MCPServerNotFoundError } from './mcp-manager.js'
import { MCPConfigParseError } from './mcp-config-loader.js'
import type { MCPClientOptions } from './mcp-client.js'
import type { Tool } from '@noetaris/harness-types'

let mockConnect = vi.fn().mockResolvedValue(undefined)
let mockListTools = vi.fn().mockResolvedValue({ tools: [] })
let httpCtorSpy = vi.fn()

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    get connect() { return mockConnect }
    get close() { return vi.fn().mockResolvedValue(undefined) }
    get listTools() { return mockListTools }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(...args: unknown[]) { httpCtorSpy(...args) }
    sessionId: string | undefined = undefined
    start = vi.fn()
    close = vi.fn()
    send = vi.fn()
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    start = vi.fn()
    close = vi.fn()
    send = vi.fn()
  },
}))

vi.mock('node:fs', () => ({
  watch: vi.fn(),
}))

vi.mock('./mcp-config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcp-config-loader.js')>()
  return {
    ...actual,
    loadMCPConfig: vi.fn(),
  }
})

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

type FSWatcherStub = {
  on: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  handlerMap: Record<string, (...args: unknown[]) => void>
}

function makeFSWatcherStub(): FSWatcherStub {
  const handlerMap: Record<string, (...args: unknown[]) => void> = {}
  const stub: FSWatcherStub = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlerMap[event] = handler
    }),
    close: vi.fn(),
    handlerMap,
  }
  return stub
}

describe('MCPManager', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    mockConnect = vi.fn().mockResolvedValue(undefined)
    mockListTools = vi.fn().mockResolvedValue({ tools: [] })
    httpCtorSpy = vi.fn()
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

  describe('watch()', () => {

    describe('initial setup and no-early-reload guarantee', () => {

      it('calls addServer with new entry when file changes from empty to one HTTP server', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([{ url: 'http://localhost:3000' }])

        const manager = new MCPManager([])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json')

        // act
        stub.handlerMap['change']!('change', 'config.json')
        await vi.advanceTimersByTimeAsync(150)

        // assert
        expect(manager.addServer).toHaveBeenCalledOnce()
        expect(manager.addServer).toHaveBeenCalledWith({ url: 'http://localhost:3000' })
        expect(manager.removeServer).not.toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('does not call addServer or removeServer when no file-change event has fired', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const manager = new MCPManager([])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/any/config.json')
        await vi.advanceTimersByTimeAsync(200)

        // act (no file change emitted)

        // assert
        expect(manager.addServer).not.toHaveBeenCalled()
        expect(manager.removeServer).not.toHaveBeenCalled()

        vi.useRealTimers()
      })

    })

    describe('delta computation — adds, removes, and no-ops', () => {

      it('removes server A and adds server B when config changes from {A,B} to {B}', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([{ url: 'http://b' }])

        const clientA = makeStubClient({ url: 'http://a' })
        const manager = new MCPManager([clientA])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json')
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(manager.addServer).toHaveBeenCalledOnce()
        expect(manager.addServer).toHaveBeenCalledWith({ url: 'http://b' })
        expect(manager.removeServer).toHaveBeenCalledOnce()
        expect(manager.removeServer).toHaveBeenCalledWith('http://a')

        vi.useRealTimers()
      })

      it('calls neither addServer nor removeServer when config entry set is unchanged', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([{ url: 'http://a' }])

        const clientA = makeStubClient({ url: 'http://a' })
        const manager = new MCPManager([clientA])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json')
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(manager.addServer).not.toHaveBeenCalled()
        expect(manager.removeServer).not.toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('removes and re-adds HTTP server when only its prefix option changes', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([{ url: 'http://a', prefix: '/new' }])

        const clientA = makeStubClient({ url: 'http://a', options: { prefix: '/old' } })
        const manager = new MCPManager([clientA])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json')
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(manager.removeServer).toHaveBeenCalledOnce()
        expect(manager.removeServer).toHaveBeenCalledWith('http://a')
        expect(manager.addServer).toHaveBeenCalledOnce()
        expect(manager.addServer).toHaveBeenCalledWith({ url: 'http://a', prefix: '/new' })

        vi.useRealTimers()
      })

      it('treats stdio server with same command as present (no remove, no add)', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([{ command: 'npx', args: ['my-tool'] }])

        const clientA = makeStubClient({ command: 'npx' })
        const manager = new MCPManager([clientA])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json')
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(manager.addServer).not.toHaveBeenCalled()
        expect(manager.removeServer).not.toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('treats "http://a" and "http://A" as different servers (case-sensitive)', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([{ url: 'http://A' }])

        const clientA = makeStubClient({ url: 'http://a' })
        const manager = new MCPManager([clientA])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json')
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(manager.removeServer).toHaveBeenCalledWith('http://a')
        expect(manager.addServer).toHaveBeenCalledWith({ url: 'http://A' })

        vi.useRealTimers()
      })

    })

    describe('apply order — adds-first, then removes', () => {

      it('does not call removeServer when addServer throws (removes are deferred until all adds succeed)', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([{ url: 'http://b' }])

        const clientA = makeStubClient({ url: 'http://a' })
        const manager = new MCPManager([clientA])
        const onError = vi.fn()
        vi.spyOn(manager, 'addServer').mockRejectedValue(new Error('connect failed'))
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json', { onError })
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(manager.addServer).toHaveBeenCalledOnce()
        expect(manager.removeServer).not.toHaveBeenCalled()
        expect(onError).toHaveBeenCalledOnce()

        vi.useRealTimers()
      })

    })

    describe('rollback on add failure', () => {

      it('rolls back first successful add when second add fails (two new servers)', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([
          { url: 'http://b1' },
          { url: 'http://b2' },
        ])

        const manager = new MCPManager([])
        const onError = vi.fn()
        vi.spyOn(manager, 'addServer')
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('connection refused'))
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json', { onError })
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(manager.addServer).toHaveBeenCalledTimes(2)
        expect(manager.removeServer).toHaveBeenCalledOnce()
        expect(manager.removeServer).toHaveBeenCalledWith('http://b1')
        expect(onError).toHaveBeenCalledOnce()
        expect(onError).toHaveBeenCalledWith(expect.any(Error))

        vi.useRealTimers()
      })

      it('calls onError and leaves server set unchanged when the new server fails to connect', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([{ url: 'http://new-server' }])

        const manager = new MCPManager([])
        const onError = vi.fn()
        vi.spyOn(manager, 'addServer').mockRejectedValue(new Error('ECONNREFUSED'))
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json', { onError })
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(onError).toHaveBeenCalledOnce()
        expect(onError).toHaveBeenCalledWith(expect.any(Error))
        expect(manager.removeServer).not.toHaveBeenCalled()

        vi.useRealTimers()
      })

    })

    describe('remove-failure behavior', () => {

      it('keeps server B when removeServer(A) throws after addServer(B) succeeded', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([{ url: 'http://b' }])

        const clientA = makeStubClient({ url: 'http://a' })
        const manager = new MCPManager([clientA])
        const onError = vi.fn()
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockRejectedValue(new Error('remove failed'))

        await manager.watch('/config.json', { onError })
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(manager.addServer).toHaveBeenCalledOnce()
        expect(manager.addServer).toHaveBeenCalledWith({ url: 'http://b' })
        expect(manager.removeServer).toHaveBeenCalledOnce()
        expect(onError).toHaveBeenCalledOnce()
        expect(onError).toHaveBeenCalledWith(expect.any(Error))
        expect(manager.addServer).toHaveBeenCalledTimes(1)

        vi.useRealTimers()
      })

    })

    describe('parse errors and silent swallowing', () => {

      it('calls onError with MCPConfigParseError and leaves server set unchanged when file is malformed JSON', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockRejectedValue(new MCPConfigParseError('/config.json', 'Unexpected token'))

        const manager = new MCPManager([])
        const onError = vi.fn()
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json', { onError })
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()

        // assert
        expect(onError).toHaveBeenCalledOnce()
        expect(onError).toHaveBeenCalledWith(expect.any(MCPConfigParseError))
        expect(manager.addServer).not.toHaveBeenCalled()
        expect(manager.removeServer).not.toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('does not throw or produce unhandled rejection when file is malformed and no onError provided', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockRejectedValue(new MCPConfigParseError('/config.json', 'bad json'))

        let hadUnhandled = false
        const unhandledHandler = () => { hadUnhandled = true }
        process.once('unhandledRejection', unhandledHandler)

        const manager = new MCPManager([])
        await manager.watch('/config.json')
        stub.handlerMap['change']!('change', 'config.json')

        // act
        await vi.runAllTimersAsync()
        await Promise.resolve()

        // assert
        process.removeListener('unhandledRejection', unhandledHandler)
        expect(hadUnhandled).toBe(false)

        vi.useRealTimers()
      })

    })

    describe('fs.watch error event', () => {

      it('calls onError, closes the watcher, and fires no further reloads when fs.watch emits error', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockReturnValue([] as never)

        const manager = new MCPManager([])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        const onError = vi.fn()

        await manager.watch('/config.json', { onError })
        const errorHandler = stub.handlerMap['error']!
        const changeHandler = stub.handlerMap['change']!

        // act
        errorHandler(new Error('ENOENT watched file deleted'))
        changeHandler('change', 'config.json')
        await vi.advanceTimersByTimeAsync(150)

        // assert
        expect(onError).toHaveBeenCalledOnce()
        expect(onError).toHaveBeenCalledWith(expect.any(Error))
        expect(stub.close).toHaveBeenCalledOnce()
        expect(loadMCPConfig).not.toHaveBeenCalled()

        vi.useRealTimers()
      })

    })

    describe('debounce behavior', () => {

      it('fires exactly one reload cycle after a single file change once the debounce window elapses', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([])

        const manager = new MCPManager([])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json')
        stub.handlerMap['change']!('change', 'config.json')
        await vi.advanceTimersByTimeAsync(50)

        // act
        await vi.advanceTimersByTimeAsync(60)

        // assert
        expect(loadMCPConfig).toHaveBeenCalledTimes(1)

        vi.useRealTimers()
      })

      it('coalesces two rapid change events into one reload cycle', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([])

        const manager = new MCPManager([])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)
        vi.spyOn(manager, 'removeServer').mockResolvedValue(undefined)

        await manager.watch('/config.json')
        stub.handlerMap['change']!('change', 'config.json')
        await vi.advanceTimersByTimeAsync(50)
        stub.handlerMap['change']!('change', 'config.json')
        await vi.advanceTimersByTimeAsync(50)

        // act
        await vi.advanceTimersByTimeAsync(60)

        // assert
        expect(loadMCPConfig).toHaveBeenCalledTimes(1)

        vi.useRealTimers()
      })

    })

    describe('dispose lifecycle', () => {

      it('subsequent file changes do not trigger reload after dispose() resolves', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([])

        const manager = new MCPManager([])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)

        const dispose = await manager.watch('/config.json')
        await dispose()

        // act
        stub.handlerMap['change']!('change', 'config.json')
        await vi.advanceTimersByTimeAsync(150)

        // assert
        expect(stub.close).toHaveBeenCalledOnce()
        expect(loadMCPConfig).not.toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('await dispose() resolves with undefined', async () => {
        // arrange
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const manager = new MCPManager([])
        const dispose = await manager.watch('/config.json')

        // act
        const result = await dispose()

        // assert
        expect(result).toBeUndefined()
      })

      it('returns resolved Promise<void> without error when dispose() is called a second time', async () => {
        // arrange
        const { watch: fsMockWatch } = await import('node:fs')
        const stub = makeFSWatcherStub()
        vi.mocked(fsMockWatch).mockReturnValue(stub as unknown as ReturnType<typeof fsMockWatch>)

        const manager = new MCPManager([])
        const dispose = await manager.watch('/config.json')
        await dispose()

        // act
        await dispose()

        // assert
        expect(stub.close).toHaveBeenCalledOnce()
      })

      it('second watcher continues firing reloads after the first watcher is disposed', async () => {
        // arrange
        vi.useFakeTimers()
        const { watch: fsMockWatch } = await import('node:fs')
        const stub1 = makeFSWatcherStub()
        const stub2 = makeFSWatcherStub()
        vi.mocked(fsMockWatch)
          .mockReturnValueOnce(stub1 as unknown as ReturnType<typeof fsMockWatch>)
          .mockReturnValueOnce(stub2 as unknown as ReturnType<typeof fsMockWatch>)

        const { loadMCPConfig } = await import('./mcp-config-loader.js')
        vi.mocked(loadMCPConfig).mockResolvedValue([])

        const manager = new MCPManager([])
        vi.spyOn(manager, 'addServer').mockResolvedValue(undefined)

        const dispose1 = await manager.watch('/config.json')
        const dispose2 = await manager.watch('/config.json')
        await dispose1()

        // act
        stub2.handlerMap['change']!('change', 'config.json')
        await vi.runAllTimersAsync()

        // assert
        expect(stub1.close).toHaveBeenCalledOnce()
        expect(stub2.close).not.toHaveBeenCalled()
        expect(loadMCPConfig).toHaveBeenCalledTimes(1)

        await dispose2()
        vi.useRealTimers()
      })

    })

  })

  describe('addServer() — HTTP auth header forwarding', () => {

    it('forwards single Authorization header to transport when addServer is called with one header', async () => {
      // arrange
      mockConnect = vi.fn().mockResolvedValue(undefined)
      mockListTools = vi.fn().mockResolvedValue({ tools: [] })
      const manager = new MCPManager([])

      // act
      await manager.addServer({ url: 'https://api.example.com/mcp', headers: { 'Authorization': 'Bearer tok' } })

      // assert
      expect(httpCtorSpy).toHaveBeenCalledOnce()
      expect(httpCtorSpy).toHaveBeenCalledWith(expect.any(URL), { requestInit: { headers: { 'Authorization': 'Bearer tok' } } })
    })

    it('forwards all headers to transport when addServer is called with multiple headers', async () => {
      // arrange
      mockConnect = vi.fn().mockResolvedValue(undefined)
      mockListTools = vi.fn().mockResolvedValue({ tools: [] })
      const manager = new MCPManager([])

      // act
      await manager.addServer({ url: 'https://api.example.com/mcp', headers: { 'X-Api-Key': 'key123', 'X-Tenant': 'abc' } })

      // assert
      expect(httpCtorSpy).toHaveBeenCalledWith(expect.any(URL), { requestInit: { headers: { 'X-Api-Key': 'key123', 'X-Tenant': 'abc' } } })
    })

    it('passes undefined as second argument to transport when MCPHttpParams has no headers field', async () => {
      // arrange
      mockConnect = vi.fn().mockResolvedValue(undefined)
      mockListTools = vi.fn().mockResolvedValue({ tools: [] })
      const manager = new MCPManager([])

      // act
      await manager.addServer({ url: 'https://api.example.com/mcp' })

      // assert
      expect(httpCtorSpy).toHaveBeenCalledOnce()
      expect(httpCtorSpy).toHaveBeenCalledWith(expect.any(URL), undefined)
    })

    it('passes requestInit with empty headers object to transport when MCPHttpParams.headers is an empty object', async () => {
      // arrange
      mockConnect = vi.fn().mockResolvedValue(undefined)
      mockListTools = vi.fn().mockResolvedValue({ tools: [] })
      const manager = new MCPManager([])

      // act
      await manager.addServer({ url: 'https://api.example.com/mcp', headers: {} })

      // assert
      expect(httpCtorSpy).toHaveBeenCalledWith(expect.any(URL), { requestInit: { headers: {} } })
    })

  })

})
