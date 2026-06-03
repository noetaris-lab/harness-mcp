import { describe, it, expect, vi, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadMCPConfig } from './mcp-config-loader.js'
import { MCPConfigParseError, MCPConfigExtensionError } from './mcp-config-loader.js'

const tmpdir = os.tmpdir()

function writeTempFile(name: string, content: string): string {
  const filePath = path.join(tmpdir, name)
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadMCPConfig', () => {

  describe('Group 1: JSON file — happy path parsing', () => {

    it('returns params in servers array order for a valid JSON file with multiple entries', async () => {
      // arrange
      const tempPath = writeTempFile('case1_1.json', JSON.stringify({
        servers: [
          { transport: 'http', url: 'http://server-a.example' },
          { transport: 'stdio', command: 'run-b', args: ['--port', '8080'] },
        ],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({ url: 'http://server-a.example' })
      expect(result[1]).toEqual({ command: 'run-b', args: ['--port', '8080'] })
    })

    it('returns empty array for JSON file with empty servers array', async () => {
      // arrange
      const tempPath = writeTempFile('case1_2.json', JSON.stringify({ servers: [] }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toEqual([])
    })

    it('returns mixed HTTP and stdio params in original order for JSON with both types', async () => {
      // arrange
      const tempPath = writeTempFile('case1_3.json', JSON.stringify({
        servers: [
          { url: 'http://alpha.example' },
          { transport: 'stdio', command: 'cmd-beta' },
          { transport: 'http', url: 'http://gamma.example', prefix: 'g' },
        ],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(3)
      expect(result[0]).toEqual({ url: 'http://alpha.example' })
      expect(result[1]).toEqual({ command: 'cmd-beta' })
      expect(result[2]).toEqual({ url: 'http://gamma.example', prefix: 'g' })
    })

  })

  describe('Group 2: JSON file — transport defaulting and field stripping', () => {

    it('treats entry with omitted transport as HTTP and strips transport from result', async () => {
      // arrange
      const tempPath = writeTempFile('case2_1.json', JSON.stringify({
        servers: [{ url: 'http://default.example' }],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ url: 'http://default.example' })
      expect(result[0]).not.toHaveProperty('transport')
    })

    it('validates explicit transport: "http" entry and strips transport from result', async () => {
      // arrange
      const tempPath = writeTempFile('case2_2.json', JSON.stringify({
        servers: [{ transport: 'http', url: 'http://explicit.example' }],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result[0]).toEqual({ url: 'http://explicit.example' })
      expect(result[0]).not.toHaveProperty('transport')
    })

    it('validates stdio entry with all optional fields and strips transport from result', async () => {
      // arrange
      const tempPath = writeTempFile('case2_3.json', JSON.stringify({
        servers: [{
          transport: 'stdio',
          command: 'my-server',
          args: ['--verbose'],
          env: { DEBUG: '1' },
          prefix: 'ms',
          rediscover: 'per-session',
        }],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result[0]).toEqual({ command: 'my-server', args: ['--verbose'], env: { DEBUG: '1' }, prefix: 'ms', rediscover: 'per-session' })
      expect(result[0]).not.toHaveProperty('transport')
    })

  })

  describe('Group 3: TypeScript/JavaScript file loading', () => {

    // Note: vitest.config.ts does not register a TS dynamic-import loader,
    // so cases that would use .ts files use .js files instead.

    it('returns parsed params from a .js file default export (equivalent to .ts case)', async () => {
      // arrange
      const tempPath = writeTempFile('case3_1.js', `export default { servers: [{ url: 'http://ts-server.example' }] }`)

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ url: 'http://ts-server.example' })
    })

    it('returns parsed params from a .js file default export', async () => {
      // arrange
      const tempPath = writeTempFile('case3_2.js', `export default { servers: [{ transport: 'stdio', command: 'js-server', args: ['--flag'] }] }`)

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ command: 'js-server', args: ['--flag'] })
    })

    it('returns parsed params from a .mjs file default export', async () => {
      // arrange
      const tempPath = writeTempFile('case3_3.mjs', `export default { servers: [{ url: 'http://mjs-server.example' }] }`)

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ url: 'http://mjs-server.example' })
    })

    it('preserves prefix and rediscover on HTTP entry loaded from a .js file', async () => {
      // arrange
      const tempPath = writeTempFile('case3_4.js', `export default { servers: [{ url: 'http://rich.example', prefix: 'rich', rediscover: 'per-session' }] }`)

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result[0]).toEqual({ url: 'http://rich.example', prefix: 'rich', rediscover: 'per-session' })
      expect(result[0]).not.toHaveProperty('transport')
    })

  })

  describe('Group 4: Path resolution', () => {

    it('resolves a relative path against process.cwd() before reading the file', async () => {
      // arrange
      const absPath = path.join(os.tmpdir(), 'case4_1.json')
      fs.writeFileSync(absPath, JSON.stringify({ servers: [] }), 'utf-8')
      vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir())
      const relativePath = './case4_1.json'

      // act
      const result = await loadMCPConfig(relativePath)

      // assert
      expect(result).toEqual([])
      expect(process.cwd).toHaveBeenCalled()
    })

    it('uses an absolute path as-is without further resolution', async () => {
      // arrange
      const absPath = path.join(os.tmpdir(), 'case4_2.json')
      fs.writeFileSync(absPath, JSON.stringify({ servers: [{ url: 'http://abs.example' }] }), 'utf-8')
      vi.spyOn(process, 'cwd').mockReturnValue('/some/other/dir')

      // act
      const result = await loadMCPConfig(absPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ url: 'http://abs.example' })
    })

  })

  describe('Group 5: Extension dispatch — unsupported extensions', () => {

    it('throws MCPConfigExtensionError with extension: ".yaml" for a .yaml path', async () => {
      // arrange
      const fakePath = '/tmp/mcp.yaml'

      // act
      const promise = loadMCPConfig(fakePath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigExtensionError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigExtensionError)
      expect(error.extension).toBe('.yaml')
      expect(error.path).toBe(fakePath)
    })

    it('throws MCPConfigExtensionError with extension: "" for a path with no extension', async () => {
      // arrange
      const fakePath = '/tmp/mcp-config'

      // act
      const promise = loadMCPConfig(fakePath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigExtensionError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigExtensionError)
      expect(error.extension).toBe('')
    })

    it('throws MCPConfigExtensionError for .JSON uppercase (case-sensitive matching)', async () => {
      // arrange
      const fakePath = '/tmp/mcp.JSON'

      // act
      const promise = loadMCPConfig(fakePath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigExtensionError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigExtensionError)
      expect(error.extension).toBe('.JSON')
    })

  })

  describe('Group 6: JSON parse errors — structure validation', () => {

    it('throws MCPConfigParseError for malformed JSON content', async () => {
      // arrange
      const tempPath = writeTempFile('case6_1.json', '{bad json}')

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.path).toBe(tempPath)
      expect(error.detail).toBeTruthy()
    })

    it('throws MCPConfigParseError when top-level JSON value is not an object', async () => {
      // arrange
      const tempPath = writeTempFile('case6_2.json', '[1, 2]')

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/object/)
    })

    it('throws MCPConfigParseError when JSON object has no servers property', async () => {
      // arrange
      const tempPath = writeTempFile('case6_3.json', JSON.stringify({ something: [] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers/)
    })

    it('throws MCPConfigParseError when servers is present but not an array', async () => {
      // arrange
      const tempPath = writeTempFile('case6_4.json', JSON.stringify({ servers: 'http://example' }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers/)
    })

  })

  describe('Group 7: File I/O error — missing file', () => {

    it('throws MCPConfigParseError with ENOENT detail for a non-existent .json path', async () => {
      // arrange
      const nonExistentPath = '/tmp/__does_not_exist_mcp_case7_1__.json'

      // act
      const promise = loadMCPConfig(nonExistentPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.path).toBe(nonExistentPath)
      expect(error.detail).toMatch(/ENOENT|no such file/i)
    })

  })

  describe('Group 8: Entry validation errors', () => {

    it('throws MCPConfigParseError when HTTP entry is missing url', async () => {
      // arrange
      const tempPath = writeTempFile('case8_1.json', JSON.stringify({ servers: [{ transport: 'http' }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/url/)
    })

    it('throws MCPConfigParseError when HTTP entry url is not a string', async () => {
      // arrange
      const tempPath = writeTempFile('case8_2.json', JSON.stringify({ servers: [{ url: 42 }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/url/)
    })

    it('throws MCPConfigParseError when stdio entry is missing command', async () => {
      // arrange
      const tempPath = writeTempFile('case8_3.json', JSON.stringify({ servers: [{ transport: 'stdio' }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/command/)
    })

    it('throws MCPConfigParseError when stdio entry command is not a string', async () => {
      // arrange
      const tempPath = writeTempFile('case8_4.json', JSON.stringify({ servers: [{ transport: 'stdio', command: 99 }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/command/)
    })

    it('throws MCPConfigParseError when stdio entry args is present but not an array', async () => {
      // arrange
      const tempPath = writeTempFile('case8_5.json', JSON.stringify({ servers: [{ transport: 'stdio', command: 'srv', args: 'not-an-array' }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/args/)
    })

    it('throws MCPConfigParseError when stdio entry args array contains a non-string element', async () => {
      // arrange
      const tempPath = writeTempFile('case8_6.json', JSON.stringify({ servers: [{ transport: 'stdio', command: 'srv', args: ['ok', 42] }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/args/)
    })

    it('throws MCPConfigParseError for an unknown transport value', async () => {
      // arrange
      const tempPath = writeTempFile('case8_7.json', JSON.stringify({ servers: [{ transport: 'grpc', url: 'http://x.example' }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/grpc/)
    })

    it('throws MCPConfigParseError when prefix is present but not a string', async () => {
      // arrange
      const tempPath = writeTempFile('case8_8.json', JSON.stringify({ servers: [{ url: 'http://x.example', prefix: 123 }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/prefix/)
    })

    it('throws MCPConfigParseError when rediscover is present but not "per-session"', async () => {
      // arrange
      const tempPath = writeTempFile('case8_9.json', JSON.stringify({ servers: [{ url: 'http://x.example', rediscover: 'always' }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/rediscover/)
    })

    it('throws MCPConfigParseError when stdio env is not a plain object', async () => {
      // arrange
      const tempPath = writeTempFile('case8_10.json', JSON.stringify({ servers: [{ transport: 'stdio', command: 'srv', env: ['KEY=val'] }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/env/)
    })

    it('throws MCPConfigParseError when stdio env is a plain object with a non-string value', async () => {
      // arrange
      const tempPath = writeTempFile('case8_11.json', JSON.stringify({ servers: [{ transport: 'stdio', command: 'srv', env: { PORT: 8080 } }] }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).toMatch(/env/)
    })

    it('fails fast on the first invalid entry and does not accumulate errors', async () => {
      // arrange
      const tempPath = writeTempFile('case8_12.json', JSON.stringify({
        servers: [
          { transport: 'http' },
          { transport: 'stdio' },
        ],
      }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/servers\[0\]/)
      expect(error.detail).not.toMatch(/servers\[1\]/)
    })

  })

  describe('Group 9: Dynamic import load failures (error propagation)', () => {

    // Note: vitest.config.ts does not register a TS loader; using .js extension
    it('propagates raw error (not MCPConfigParseError) for a non-existent .js path', async () => {
      // arrange
      const nonExistentJsPath = '/tmp/__does_not_exist_mcp_case9_1__.js'

      // act
      const promise = loadMCPConfig(nonExistentJsPath)

      // assert
      await expect(promise).rejects.toThrow()
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(MCPConfigParseError)
    })

    it('propagates raw error (not MCPConfigParseError) for a .js file with a syntax error', async () => {
      // arrange
      const tempPath = writeTempFile('case9_2.js', 'export default { this is not valid js }')

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow()
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(MCPConfigParseError)
    })

  })

  describe('Group 10: Dynamic import — missing or invalid default export', () => {

    // Note: vitest.config.ts does not register a TS loader; using .js extension
    it('throws MCPConfigParseError when a .js file has no default export', async () => {
      // arrange
      const tempPath = writeTempFile('case10_1.js', 'export const servers = []')

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/default/)
    })

    it('throws MCPConfigParseError when a .js file default export is null', async () => {
      // arrange
      const tempPath = writeTempFile('case10_2.js', 'export default null')

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toMatch(/default/)
    })

  })

  describe('Group 11: HTTP headers — happy path mapping', () => {

    it('includes headers in returned MCPHttpParams when HTTP entry has a single header', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch1_1.json', JSON.stringify({
        servers: [{ url: 'http://api.example.com/mcp', headers: { 'Authorization': 'Bearer tok' } }],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ url: 'http://api.example.com/mcp', headers: { 'Authorization': 'Bearer tok' } })
      expect(result[0]).not.toHaveProperty('transport')
    })

    it('includes all headers in MCPHttpParams.headers when HTTP entry has multiple headers', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch1_2.json', JSON.stringify({
        servers: [{ url: 'http://api.example.com/mcp', headers: { 'X-Api-Key': 'k1', 'X-Tenant': 't1' } }],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ url: 'http://api.example.com/mcp', headers: { 'X-Api-Key': 'k1', 'X-Tenant': 't1' } })
    })

    it('includes headers in MCPHttpParams when loaded from a .js config file', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch1_3.js', `export default { servers: [{ url: 'http://ts-server.example', headers: { 'X-Api-Key': 'secret' } }] }`)

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ url: 'http://ts-server.example', headers: { 'X-Api-Key': 'secret' } })
    })

  })

  describe('Group 12: HTTP headers — no-headers and stdio-ignored-headers edge cases', () => {

    it('does not include headers in MCPHttpParams when HTTP entry omits the field', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch2_1.json', JSON.stringify({
        servers: [{ url: 'http://api.example.com/mcp' }],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).not.toHaveProperty('headers')
    })

    it('does not include headers in MCPStdioParams when stdio entry has a headers-like field', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch2_2.json', JSON.stringify({
        servers: [{ transport: 'stdio', command: 'run-server', headers: { 'Authorization': 'Bearer tok' } }],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ command: 'run-server' })
      expect(result[0]).not.toHaveProperty('headers')
    })

    it('includes headers: {} in MCPHttpParams when HTTP entry has an empty headers object', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch2_3.json', JSON.stringify({
        servers: [{ url: 'http://api.example.com/mcp', headers: {} }],
      }))

      // act
      const result = await loadMCPConfig(tempPath)

      // assert
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({ url: 'http://api.example.com/mcp', headers: {} })
    })

  })

  describe('Group 13: HTTP headers — validation errors', () => {

    it('throws MCPConfigParseError with correct detail when headers is a string', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch3_1.json', JSON.stringify({
        servers: [{ url: 'http://api.example.com/mcp', headers: 'Bearer tok' }],
      }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toBe('servers[0]: headers must be a plain object with string values')
      expect(error.path).toBe(tempPath)
    })

    it('throws MCPConfigParseError with correct detail when headers is null', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch3_2.json', JSON.stringify({
        servers: [{ url: 'http://api.example.com/mcp', headers: null }],
      }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toBe('servers[0]: headers must be a plain object with string values')
    })

    it('throws MCPConfigParseError with correct detail when headers is an array', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch3_3.json', JSON.stringify({
        servers: [{ url: 'http://api.example.com/mcp', headers: ['Authorization: Bearer tok'] }],
      }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toBe('servers[0]: headers must be a plain object with string values')
    })

    it('throws MCPConfigParseError with correct detail when a header value is not a string', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch3_4.json', JSON.stringify({
        servers: [{ url: 'http://api.example.com/mcp', headers: { 'Authorization': 42 } }],
      }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toBe('servers[0]: headers must be a plain object with string values')
    })

    it('error detail contains servers[1] when invalid headers is on the second entry', async () => {
      // arrange
      const tempPath = writeTempFile('case_ch3_5.json', JSON.stringify({
        servers: [
          { url: 'http://server-a.example/mcp', headers: { 'Authorization': 'Bearer tok' } },
          { url: 'http://server-b.example/mcp', headers: null },
        ],
      }))

      // act
      const promise = loadMCPConfig(tempPath)

      // assert
      await expect(promise).rejects.toThrow(MCPConfigParseError)
      const error = await promise.catch(e => e)
      expect(error).toBeInstanceOf(MCPConfigParseError)
      expect(error.detail).toBe('servers[1]: headers must be a plain object with string values')
      expect(error.detail).not.toMatch(/servers\[0\]/)
    })

  })

})
