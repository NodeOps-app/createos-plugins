/** Small helpers shared across the extension. */

export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function shortId(id: string): string {
  return id.slice(0, 12)
}

export function joinPath(base: string, child: string): string {
  return `${base.replace(/[/]+$/, '')}/${child.replace(/^[/]+/, '')}`
}
