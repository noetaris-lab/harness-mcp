import { readFileSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { MCPHttpParams } from './mcp-manager.js'
import type { MCPStdioParams } from './mcp-client.js'

export interface MCPHttpEntry {
  transport?: 'http'
  url: string
  prefix?: string
  rediscover?: 'per-session'
  headers?: Record<string, string>
}

export interface MCPStdioEntry {
  transport: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  prefix?: string
  rediscover?: 'per-session'
}

export type MCPServerEntry = MCPHttpEntry | MCPStdioEntry

export interface MCPConfigSchema {
  servers: MCPServerEntry[]
}

export class MCPConfigParseError extends Error {
  readonly path: string
  readonly detail: string
  constructor(path: string, detail: string) {
    super(`invalid MCP config at ${path}: ${detail}`)
    this.name = 'MCPConfigParseError'
    this.path = path
    this.detail = detail
  }
}

export class MCPConfigExtensionError extends Error {
  readonly path: string
  readonly extension: string
  constructor(path: string, extension: string) {
    super(`unsupported config file extension "${extension}" at ${path}: expected .json, .ts, .js, or .mjs`)
    this.name = 'MCPConfigExtensionError'
    this.path = path
    this.extension = extension
  }
}

function validateEntry(entry: unknown, index: number, configPath: string): MCPHttpParams | MCPStdioParams {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new MCPConfigParseError(configPath, `servers[${index}]: entry must be an object`)
  }

  const raw = entry as Record<string, unknown> // as: entry is not-null object (Array check above); Record<string,unknown> is the narrowest safe widening

  // default transport to 'http' if absent
  const transport = raw['transport'] === undefined ? 'http' : raw['transport']

  if (transport !== 'http' && transport !== 'stdio') {
    throw new MCPConfigParseError(configPath, `servers[${index}]: unrecognized transport value "${String(transport)}"`)
  }

  // validate shared optional fields
  if (raw['prefix'] !== undefined && typeof raw['prefix'] !== 'string') {
    throw new MCPConfigParseError(configPath, `servers[${index}]: prefix must be a string`)
  }

  if (raw['rediscover'] !== undefined && raw['rediscover'] !== 'per-session') {
    throw new MCPConfigParseError(configPath, `servers[${index}]: rediscover must be "per-session"`)
  }

  const prefix = raw['prefix'] as string | undefined // as: validated typeof === 'string' in the guard above
  const rediscover = raw['rediscover'] as 'per-session' | undefined // as: validated === 'per-session' in the guard above

  if (transport === 'http') {
    if (!('url' in raw) || raw['url'] === undefined) {
      throw new MCPConfigParseError(configPath, `servers[${index}]: http entry missing required field: url`)
    }
    if (typeof raw['url'] !== 'string') {
      throw new MCPConfigParseError(configPath, `servers[${index}]: url must be a string`)
    }

    if (raw['headers'] !== undefined) {
      const h = raw['headers']
      if (typeof h !== 'object' || h === null || Array.isArray(h)) {
        throw new MCPConfigParseError(configPath, `servers[${index}]: headers must be a plain object with string values`)
      }
      if (!Object.values(h as Record<string, unknown>).every(v => typeof v === 'string')) { // as: object/non-null/non-array confirmed above; Record<string,unknown> for Object.values narrowing
        throw new MCPConfigParseError(configPath, `servers[${index}]: headers must be a plain object with string values`)
      }
    }

    const headers = raw['headers'] as Record<string, string> | undefined // as: validated plain object with all-string values in the guard above

    const result: MCPHttpParams = { url: raw['url'] }
    if (prefix !== undefined) result.prefix = prefix
    if (rediscover !== undefined) result.rediscover = rediscover
    if (headers !== undefined) result.headers = headers
    return result
  }

  // stdio
  if (!('command' in raw) || raw['command'] === undefined) {
    throw new MCPConfigParseError(configPath, `servers[${index}]: stdio entry missing required field: command`)
  }
  if (typeof raw['command'] !== 'string') {
    throw new MCPConfigParseError(configPath, `servers[${index}]: command must be a string`)
  }

  if (raw['args'] !== undefined) {
    if (!Array.isArray(raw['args'])) {
      throw new MCPConfigParseError(configPath, `servers[${index}]: args must be a string array`)
    }
    if (!(raw['args'] as unknown[]).every(a => typeof a === 'string')) { // as: Array.isArray confirmed above; unknown[] is safe for .every narrowing
      throw new MCPConfigParseError(configPath, `servers[${index}]: args must be a string array`)
    }
  }

  if (raw['env'] !== undefined) {
    const env = raw['env']
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new MCPConfigParseError(configPath, `servers[${index}]: env must be a plain object with string values`)
    }
    if (!Object.values(env as Record<string, unknown>).every(v => typeof v === 'string')) { // as: object/non-null/non-array confirmed above; Record<string,unknown> for Object.values narrowing
      throw new MCPConfigParseError(configPath, `servers[${index}]: env must be a plain object with string values`)
    }
  }

  const result: MCPStdioParams = { command: raw['command'] }
  if (raw['args'] !== undefined) result.args = raw['args'] as string[] // as: validated Array.isArray + every element is string above
  if (raw['env'] !== undefined) result.env = raw['env'] as Record<string, string> // as: validated plain object with all-string values above
  if (prefix !== undefined) result.prefix = prefix
  if (rediscover !== undefined) result.rediscover = rediscover
  return result
}

function validateServers(data: unknown, configPath: string): Array<MCPHttpParams | MCPStdioParams> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new MCPConfigParseError(configPath, 'config must be a plain object')
  }

  const obj = data as Record<string, unknown> // as: data is non-null non-array object (guards above); Record<string,unknown> is the narrowest safe widening

  if (!Array.isArray(obj['servers'])) {
    throw new MCPConfigParseError(configPath, 'servers must be an array')
  }

  return (obj['servers'] as unknown[]).map((entry, i) => validateEntry(entry, i, configPath)) // as: Array.isArray confirmed on line above; unknown[] is the safe element type for map
}

async function loadFromDynamicImport(resolvedPath: string, originalPath: string): Promise<Array<MCPHttpParams | MCPStdioParams>> {
  const fileUrl = pathToFileURL(resolvedPath).href
  // dynamic import errors (missing file, syntax error) propagate as-is
  const mod = await import(fileUrl)
  const defaultExport: unknown = mod.default

  if (typeof defaultExport !== 'object' || defaultExport === null) {
    throw new MCPConfigParseError(originalPath, 'default export must be a non-null object (missing or invalid default export)')
  }

  return validateServers(defaultExport, originalPath)
}

function loadFromJson(resolvedPath: string, originalPath: string): Array<MCPHttpParams | MCPStdioParams> {
  let raw: string
  try {
    raw = readFileSync(resolvedPath, 'utf-8')
  } catch (err) {
    throw new MCPConfigParseError(originalPath, (err as Error).message) // as: catch binds unknown; fs errors are always Error instances with .message
  }

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new MCPConfigParseError(originalPath, (err as Error).message) // as: catch binds unknown; JSON.parse throws SyntaxError (an Error) with .message
  }

  return validateServers(data, originalPath)
}

export async function loadMCPConfig(configPath: string): Promise<Array<MCPHttpParams | MCPStdioParams>> {
  const resolvedPath = resolve(configPath)
  const ext = extname(configPath)

  if (ext === '.json') {
    return loadFromJson(resolvedPath, configPath)
  }

  if (ext === '.ts' || ext === '.js' || ext === '.mjs') {
    return loadFromDynamicImport(resolvedPath, configPath)
  }

  throw new MCPConfigExtensionError(configPath, ext)
}
