/**
 * Remote grep via `createos sandbox exec`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { sandboxExec } from './cli.ts'
import { shellQuote } from './util.ts'

export interface GrepParams {
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit?: number
}

export interface RemoteGrepResult {
  content: { type: 'text'; text: string }[]
  details: undefined
}

const DEFAULT_LIMIT = 100

export async function runRemoteGrep(
  pi: ExtensionAPI,
  sandboxId: string,
  cwd: string,
  params: GrepParams,
): Promise<RemoteGrepResult> {
  const { pattern, path: searchDir = '.', glob, ignoreCase, literal, context, limit } = params
  const max = Number.isFinite(limit ?? DEFAULT_LIMIT) ? Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)) : DEFAULT_LIMIT
  const ctxLines = Number.isFinite(context ?? 0) && (context ?? 0) > 0 ? Math.floor(context!) : 0

  const rg = ['rg', '--line-number', '--no-heading', '--color=never', '--hidden']
  if (ignoreCase) rg.push('--ignore-case')
  if (literal) rg.push('--fixed-strings')
  if (ctxLines) rg.push('--context', String(ctxLines))
  if (glob) rg.push('--glob', shellQuote(glob))
  rg.push('--', shellQuote(pattern), shellQuote(searchDir))

  const gp = ['grep', '-rnI']
  if (ignoreCase) gp.push('-i')
  if (literal) gp.push('-F')
  if (ctxLines) gp.push('-C', String(ctxLines))
  if (glob) gp.push(`--include=${shellQuote(glob)}`)
  gp.push('--', shellQuote(pattern), shellQuote(searchDir))

  const command = [
    `cd ${shellQuote(cwd)}`,
    `if command -v rg >/dev/null 2>&1; then ${rg.join(' ')} 2>/dev/null | head -n ${max}; else ${gp.join(' ')} 2>/dev/null | head -n ${max}; fi`,
    'exit 0',
  ].join('\n')

  const res = await sandboxExec(pi, sandboxId, command)
  const text = res.stdout.replace(/\s+$/, '')
  const body = text.length > 0 ? text : `No matches found for /${pattern}/ in ${searchDir}`
  return { content: [{ type: 'text', text: body }], details: undefined }
}
