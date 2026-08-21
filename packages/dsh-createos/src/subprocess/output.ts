/** Bounded collected-output projection for CreateOS streams. */

import { Buffer } from "node:buffer";
import type { SubprocessOutputRead, SubprocessOutputReader } from "@deepseek-ai/dsh-subprocess";

/** Independent offset reader retaining one configured in-memory tail. */
export class CreateOSOutputReader implements SubprocessOutputReader {
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {}

  /** Append byte-faithful output. */
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const chunk = Buffer.from(bytes);
    this.totalBytes += chunk.length;
    this.chunks.push(chunk);
    this.retainedBytes += chunk.length;
    while (this.retainedBytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer;
      const excess = this.retainedBytes - this.maxBytes;
      if (head.length <= excess) {
        this.chunks.shift();
        this.retainedBytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.retainedBytes -= excess;
      }
    }
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    const retained = Buffer.concat(this.chunks, this.retainedBytes);
    const firstRetained = this.totalBytes - this.retainedBytes;
    const lossy = fromByte < firstRetained;
    const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained));
    return {
      text: retained.subarray(start).toString("utf8"),
      nextOffset: this.totalBytes,
      lossy,
    };
  }
}

/** Decode one canonical base64 payload without accepting malformed aliases. */
export function decodeOutput(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("subprocess-createos: invalid base64 output frame");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("subprocess-createos: non-canonical base64 output frame");
  }
  return decoded;
}
