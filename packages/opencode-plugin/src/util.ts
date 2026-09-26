export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || value.includes("\0"))
    throw new Error(`${name} must be a string without NUL bytes`);
  return value;
}
export function integer(value: unknown, name: string, fallback: number, max = 3_600_000): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max)
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  return value;
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function log(event: string, error: unknown): void {
  console.error(JSON.stringify({ plugin: "createos", event, error: errorText(error) }));
}
