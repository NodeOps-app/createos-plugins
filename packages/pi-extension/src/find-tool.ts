/**
 * Remote find via `createos sandbox exec`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { sandboxExec } from './cli.ts'
import { joinPath, shellQuote } from './util.ts'

export interface FindParams {
  pattern: string
  path?: string
  limit?: number
}

export interface RemoteSearchResult {
  content: { type: 'text'; text: string }[]
  details: undefined
}

const DEFAULT_LIMIT = 1000

export async function runRemoteFind(
  pi: ExtensionAPI,
  sandboxId: string,
  cwd: string,
  params: FindParams,
): Promise<RemoteSearchResult> {
  const { pattern, path: searchDir = '.', limit } = params
  const max = Number.isFinite(limit ?? DEFAULT_LIMIT) ? Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)) : DEFAULT_LIMIT
  const searchPath = searchDir.startsWith('/') ? searchDir : joinPath(cwd, searchDir)

  let effective = pattern
  if (pattern.includes('/') && !pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**') {
    effective = `**/${pattern}`
  }
  const basename = effective.split('/').pop() || effective

  const rg = `rg --files --hidden -g ${shellQuote('!**/.git/**')} -g ${shellQuote('!**/node_modules/**')} -g ${shellQuote(effective)}`
  const find = `find . -type f -name ${shellQuote(basename)} ! -path ${shellQuote('*/.git/*')} ! -path ${shellQuote('*/node_modules/*')}`

  const command = [
    `cd ${shellQuote(searchPath)}`,
    `if command -v rg >/dev/null 2>&1; then ${rg} 2>/dev/null | head -n ${max}; else ${find} 2>/dev/null | head -n ${max}; fi`,
    'exit 0',
  ].join('\n')

  const res = await sandboxExec(pi, sandboxId, command)
  const lines = res.stdout
    .split('\n')
    .map((l) => l.replace(/^\.\//, '').replace(/\r$/, ''))
    .filter((l) => l.length > 0)

  const body = lines.length > 0 ? lines.join('\n') : 'No files found matching pattern'
  return { content: [{ type: 'text', text: body }], details: undefined }
}
