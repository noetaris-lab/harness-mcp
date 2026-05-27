import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { MCPClient } from './mcp-client.js'
import { MCPManager } from './mcp-manager.js'
import { MCPConfigParseError, MCPConfigExtensionError } from './mcp-config-loader.js'
import type { MCPClientOptions } from './mcp-client.js'
import type { Tool } from '@noetaris/harness-types'

// hoisted mock — lets each test control what loadMCPConfig returns
vi.mock('./mcp-config-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcp-config-loader.js')>()
  return {
    ...actual,
    loadMCPConfig: vi.fn(),
  }
})

// import the mocked module so tests can configure it per-case
import { loadMCPConfig } from './mcp-config-loader.js'

// Stub factory helpers

function makeStubClient(overrides: {
  url?: string
  command?: string
  options?: MCPClientOptions
  tools?: Tool[]
}): MCPClient {
  const stub = {
    url: overrides.url,
    command: overrides.command,
    options: overrides.options ?? {},
    transportKind: overrides.url !== undefined ? 'http' : 'stdio',
    tools: vi.fn().mockReturnValue(overrides.tools ?? []),
    discover: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }
  return stub as unknown as MCPClient // as: stub is a minimal structural stand-in for MCPClient
}

describe('MCPManagerConfig', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
  })

  describe('loadConfig() — server addition with HTTP entries', () => {

    it('adds tools from both HTTP entries when manager is initially empty', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([{ url: 'http://s1' }, { url: 'http://s2' }])
      const stubClient1 = makeStubClient({ url: 'http://s1', tools: [{ name: 't1', description: '', inputSchema: {} }] })
      const stubClient2 = makeStubClient({ url: 'http://s2', tools: [{ name: 't2', description: '', inputSchema: {} }] })
      vi.spyOn(MCPClient, 'fromHttp')
        .mockResolvedValueOnce(stubClient1)
        .mockResolvedValueOnce(stubClient2)
      const manager = new MCPManager([])

      // act
      await manager.loadConfig('/some/config.json')

      // assert
      const result = manager.tools()
      expect(result).toHaveLength(2)
      expect(result.find(t => t.name === 't1')).toBeDefined()
      expect(result.find(t => t.name === 't2')).toBeDefined()
    })

    it('preserves pre-existing server and appends new server, original tools appear first', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([{ url: 'http://new' }])
      const stubExisting = makeStubClient({ url: 'http://existing', tools: [{ name: 'builtin-tool', description: '', inputSchema: {} }] })
      const stubNew = makeStubClient({ url: 'http://new', tools: [{ name: 'new-tool', description: '', inputSchema: {} }] })
      vi.spyOn(MCPClient, 'fromHttp').mockResolvedValue(stubNew)
      const manager = new MCPManager([stubExisting])

      // act
      await manager.loadConfig('/config.json')

      // assert
      const result = manager.tools()
      expect(result).toHaveLength(2)
      expect(result[0]!.name).toBe('builtin-tool')
      expect(result[1]!.name).toBe('new-tool')
    })

  })

  describe('loadConfig() — stdio entries and optional field forwarding', () => {

    it('calls MCPClient.fromStdio and adds client when config has one stdio entry', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([{ command: 'npx', args: ['-y', '@my/mcp'] }])
      const stubStdioClient = makeStubClient({ command: 'npx', tools: [{ name: 'stdio-tool', description: '', inputSchema: {} }] })
      vi.spyOn(MCPClient, 'fromStdio').mockResolvedValue(stubStdioClient)
      vi.spyOn(MCPClient, 'fromHttp')
      const manager = new MCPManager([])

      // act
      await manager.loadConfig('/config.json')

      // assert
      expect(MCPClient.fromStdio).toHaveBeenCalledOnce()
      expect(MCPClient.fromHttp).not.toHaveBeenCalled()
      expect(manager.tools()[0]!.name).toBe('stdio-tool')
    })

    it('forwards prefix and rediscover options to MCPClient.fromHttp', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([{ url: 'http://gh', prefix: 'gh', rediscover: 'per-session' }])
      const stubClient = makeStubClient({ url: 'http://gh', tools: [] })
      vi.spyOn(MCPClient, 'fromHttp').mockResolvedValue(stubClient)
      const manager = new MCPManager([])

      // act
      await manager.loadConfig('/config.json')

      // assert
      expect(MCPClient.fromHttp).toHaveBeenCalledWith('http://gh', expect.objectContaining({ prefix: 'gh', rediscover: 'per-session' }))
    })

    it('forwards args, env, prefix, and rediscover to MCPClient.fromStdio', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([{ command: 'run-server', args: ['--port', '3000'], env: { NODE_ENV: 'test' }, prefix: 'srv', rediscover: 'per-session' }])
      const stubClient = makeStubClient({ command: 'run-server', tools: [] })
      vi.spyOn(MCPClient, 'fromStdio').mockResolvedValue(stubClient)
      const manager = new MCPManager([])

      // act
      await manager.loadConfig('/config.json')

      // assert
      expect(MCPClient.fromStdio).toHaveBeenCalledWith(expect.objectContaining({
        command: 'run-server',
        args: ['--port', '3000'],
        env: { NODE_ENV: 'test' },
        prefix: 'srv',
        rediscover: 'per-session',
      }))
    })

  })

  describe('loadConfig() — insertion order', () => {

    it('calls addServer three times in config order [HTTP, stdio, HTTP] and tools() preserves that order', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([
        { url: 'http://first' },
        { command: 'middle-cmd' },
        { url: 'http://last' },
      ])
      const callOrder: string[] = []
      const stubHttp1 = makeStubClient({ url: 'http://first', tools: [{ name: 'first-tool', description: '', inputSchema: {} }] })
      const stubHttp2 = makeStubClient({ url: 'http://last', tools: [{ name: 'last-tool', description: '', inputSchema: {} }] })
      const stubStdio = makeStubClient({ command: 'middle-cmd', tools: [{ name: 'middle-tool', description: '', inputSchema: {} }] })
      vi.spyOn(MCPClient, 'fromHttp')
        .mockImplementationOnce((_url) => { callOrder.push('http'); return Promise.resolve(stubHttp1) })
        .mockImplementationOnce((_url) => { callOrder.push('http2'); return Promise.resolve(stubHttp2) })
      vi.spyOn(MCPClient, 'fromStdio')
        .mockImplementationOnce((_params) => { callOrder.push('stdio'); return Promise.resolve(stubStdio) })
      const manager = new MCPManager([])

      // act
      await manager.loadConfig('/config.json')

      // assert
      expect(callOrder).toEqual(['http', 'stdio', 'http2'])
      const result = manager.tools()
      expect(result[0]!.name).toBe('first-tool')
      expect(result[1]!.name).toBe('middle-tool')
      expect(result[2]!.name).toBe('last-tool')
    })

  })

  describe('loadConfig() — error propagation', () => {

    it('rejects with MCPConfigExtensionError and adds no servers when extension is unsupported', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockRejectedValue(new MCPConfigExtensionError('/config.yaml', '.yaml'))
      const manager = new MCPManager([])

      // act
      const p = manager.loadConfig('/config.yaml')

      // assert
      await expect(p).rejects.toThrow(MCPConfigExtensionError)
      expect(manager.tools()).toEqual([])
    })

    it('rejects with MCPConfigParseError and adds no servers when JSON is malformed', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockRejectedValue(new MCPConfigParseError('/config.json', 'Unexpected token } in JSON'))
      const manager = new MCPManager([])

      // act
      const p = manager.loadConfig('/config.json')

      // assert
      await expect(p).rejects.toThrow(MCPConfigParseError)
      expect(manager.tools()).toEqual([])
    })

    it('rejects with MCPConfigParseError before calling addServer when loader rejects due to invalid entry', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockRejectedValue(new MCPConfigParseError('/config.json', 'entry[2]: missing required field "url"'))
      vi.spyOn(MCPClient, 'fromHttp')
      vi.spyOn(MCPClient, 'fromStdio')
      const manager = new MCPManager([])

      // act
      const p = manager.loadConfig('/config.json')

      // assert
      await expect(p).rejects.toThrow(MCPConfigParseError)
      expect(MCPClient.fromHttp).not.toHaveBeenCalled()
      expect(MCPClient.fromStdio).not.toHaveBeenCalled()
      expect(manager.tools()).toEqual([])
    })

    it('propagates connection error thrown by MCPClient.fromHttp as-is', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([{ url: 'http://unreachable' }])
      vi.spyOn(MCPClient, 'fromHttp').mockRejectedValue(new Error('ECONNREFUSED'))
      const manager = new MCPManager([])

      // act
      const p = manager.loadConfig('/config.json')

      // assert
      await expect(p).rejects.toThrow('ECONNREFUSED')
      await expect(p).rejects.not.toBeInstanceOf(MCPConfigParseError)
    })

    it('retains first server and rejects with second entry\'s error when second addServer throws', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([{ url: 'http://good' }, { url: 'http://bad' }])
      const stubGood = makeStubClient({ url: 'http://good', tools: [{ name: 'good-tool', description: '', inputSchema: {} }] })
      vi.spyOn(MCPClient, 'fromHttp')
        .mockResolvedValueOnce(stubGood)
        .mockRejectedValueOnce(new Error('connection refused'))
      const manager = new MCPManager([])

      // act
      const p = manager.loadConfig('/config.json')

      // assert
      await expect(p).rejects.toThrow('connection refused')
      expect(manager.tools()).toHaveLength(1)
      expect(manager.tools()[0]!.name).toBe('good-tool')
    })

  })

  describe('loadConfig() — empty servers list', () => {

    it('resolves without calling addServer when config has an empty servers array', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([])
      vi.spyOn(MCPClient, 'fromHttp')
      vi.spyOn(MCPClient, 'fromStdio')
      const stubExisting = makeStubClient({ url: 'http://existing', tools: [{ name: 'pre-existing', description: '', inputSchema: {} }] })
      const manager = new MCPManager([stubExisting])

      // act
      await manager.loadConfig('/empty.json')

      // assert
      expect(MCPClient.fromHttp).not.toHaveBeenCalled()
      expect(MCPClient.fromStdio).not.toHaveBeenCalled()
      expect(manager.tools()).toHaveLength(1)
      expect(manager.tools()[0]!.name).toBe('pre-existing')
    })

  })

  describe('fromConfig() — factory behavior', () => {

    it('returns MCPManager instance with tools from both HTTP entries', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([{ url: 'http://s1' }, { url: 'http://s2' }])
      const stubClient1 = makeStubClient({ url: 'http://s1', tools: [{ name: 'tool-a', description: '', inputSchema: {} }] })
      const stubClient2 = makeStubClient({ url: 'http://s2', tools: [{ name: 'tool-b', description: '', inputSchema: {} }] })
      vi.spyOn(MCPClient, 'fromHttp')
        .mockResolvedValueOnce(stubClient1)
        .mockResolvedValueOnce(stubClient2)

      // act
      const manager = await MCPManager.fromConfig('/config.json')

      // assert
      expect(manager).toBeInstanceOf(MCPManager)
      const result = manager.tools()
      expect(result).toHaveLength(2)
      expect(result.find(t => t.name === 'tool-a')).toBeDefined()
      expect(result.find(t => t.name === 'tool-b')).toBeDefined()
    })

    it('returned manager is a fresh instance independent of any other manager', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([{ url: 'http://s1' }])
      vi.spyOn(MCPClient, 'fromHttp').mockResolvedValue(
        makeStubClient({ url: 'http://s1', tools: [{ name: 'shared-name', description: '', inputSchema: {} }] })
      )

      // act
      const manager1 = await MCPManager.fromConfig('/config.json')
      const manager2 = await MCPManager.fromConfig('/config.json')

      // assert
      expect(manager1).not.toBe(manager2)
    })

    it('rejects with MCPConfigParseError when file does not exist', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockRejectedValue(new MCPConfigParseError('/nonexistent.json', 'ENOENT: no such file'))

      // act
      const p = MCPManager.fromConfig('/nonexistent.json')

      // assert
      await expect(p).rejects.toThrow(MCPConfigParseError)
    })

    it('returns MCPManager with no servers and tools() returns [] when config has zero entries', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([])

      // act
      const manager = await MCPManager.fromConfig('/empty.json')

      // assert
      expect(manager).toBeInstanceOf(MCPManager)
      expect(manager.tools()).toEqual([])
    })

  })

  describe('fromConfig() — thin wrapper contract', () => {

    it('calls loadConfig exactly once with the given path on the returned instance', async () => {
      // arrange
      const loadMCPConfigMock = vi.mocked(loadMCPConfig)
      loadMCPConfigMock.mockResolvedValue([])
      const loadConfigSpy = vi.spyOn(MCPManager.prototype, 'loadConfig')

      // act
      const manager = await MCPManager.fromConfig('/my/config.json')

      // assert
      expect(loadConfigSpy).toHaveBeenCalledOnce()
      expect(loadConfigSpy).toHaveBeenCalledWith('/my/config.json')
      expect(loadConfigSpy.mock.instances[0]).toBe(manager)
    })

  })

  describe('end-to-end TypeScript/JavaScript config loading', () => {

    it('loads HTTP entry from a .ts config file via dynamic import and calls addServer', async () => {
      // arrange
      const tempPath = path.join(os.tmpdir(), 'test-config-mcp-manager.ts')
      fs.writeFileSync(tempPath, `export default { servers: [{ url: "http://ts-server" }] }\n`, 'utf-8')
      const stubClient = makeStubClient({ url: 'http://ts-server', tools: [{ name: 'ts-tool', description: '', inputSchema: {} }] })
      vi.spyOn(MCPClient, 'fromHttp').mockResolvedValue(stubClient)
      // restore loadMCPConfig to real implementation for this test
      const { loadMCPConfig: realLoad } = await vi.importActual<typeof import('./mcp-config-loader.js')>('./mcp-config-loader.js')
      vi.mocked(loadMCPConfig).mockImplementation(realLoad)
      const manager = new MCPManager([])

      // act
      await manager.loadConfig(tempPath)

      // assert
      expect(MCPClient.fromHttp).toHaveBeenCalledWith('http://ts-server', expect.any(Object))
      expect(manager.tools()[0]!.name).toBe('ts-tool')
    })

    it('loads stdio entry from a .mjs config file via dynamic import and calls addServer', async () => {
      // arrange
      const tempPath = path.join(os.tmpdir(), 'test-config-mcp-manager.mjs')
      fs.writeFileSync(tempPath, `export default { servers: [{ transport: "stdio", command: "echo", args: ["hello"] }] }\n`, 'utf-8')
      const stubClient = makeStubClient({ command: 'echo', tools: [{ name: 'mjs-tool', description: '', inputSchema: {} }] })
      vi.spyOn(MCPClient, 'fromStdio').mockResolvedValue(stubClient)
      // restore loadMCPConfig to real implementation for this test
      const { loadMCPConfig: realLoad } = await vi.importActual<typeof import('./mcp-config-loader.js')>('./mcp-config-loader.js')
      vi.mocked(loadMCPConfig).mockImplementation(realLoad)
      const manager = new MCPManager([])

      // act
      await manager.loadConfig(tempPath)

      // assert
      expect(MCPClient.fromStdio).toHaveBeenCalledWith(expect.objectContaining({ command: 'echo', args: ['hello'] }))
      expect(manager.tools()[0]!.name).toBe('mjs-tool')
    })

  })

})
