/**
 * Bounded output collection for the CreateOS subprocess provider.
 *
 * Offsets are whole-stream byte coordinates owned by the caller, so two
 * independent readers never consume one another's output. The in-memory window
 * keeps the TAIL once it overflows; the optional spill buffer keeps the
 * COMPLETE stream up to its own cap and is discarded the moment the stream
 * outgrows it, because a partial spill would misrepresent itself as complete.
 * @module @createos/dsh/output
 */

import { Buffer } from "node:buffer";
import type {
  SubprocessCollect,
  SubprocessOutputRead,
  SubprocessOutputReader,
} from "@deepseek-ai/dsh-subprocess";

/**
 * One collected stream: a bounded in-memory tail plus an optional complete-stream
 * spill buffer awaiting publication.
 */
export class CollectedStream implements SubprocessOutputReader {
  /** Whole-stream byte length seen so far. */
  private total = 0;
  /** The retained tail, at most `collect.maxBytes` long. */
  private tail: Buffer = Buffer.alloc(0);
  /** Complete stream for the spill file; undefined once it outgrew its cap. */
  private complete: Buffer | undefined;
  private spillDiscarded = false;
  private spillPath: string | undefined;

  constructor(private readonly collect: SubprocessCollect) {
    if (collect.spill !== undefined) this.complete = Buffer.alloc(0);
  }

  /** True when bytes have been dropped from the in-memory tail. */
  get truncated(): boolean {
    return this.total > this.tail.length;
  }

  /** The complete stream, or undefined when no spill was requested or it overflowed. */
  get spillContent(): Buffer | undefined {
    return this.spillDiscarded ? undefined : this.complete;
  }

  /** Record the published spill file so later reads can point at it. */
  publishSpill(path: string): void {
    this.spillPath = path;
  }

  /**
   * Append one delivered chunk.
   * @param text - stream text exactly as the control plane framed it.
   */
  append(text: string): void {
    const chunk = Buffer.from(text, "utf8");
    if (chunk.length === 0) return;
    this.total += chunk.length;

    const merged = Buffer.concat([this.tail, chunk]);
    this.tail =
      merged.length > this.collect.maxBytes
        ? merged.subarray(merged.length - this.collect.maxBytes)
        : merged;

    const spill = this.collect.spill;
    if (spill === undefined || this.spillDiscarded || this.complete === undefined) return;
    const grown = Buffer.concat([this.complete, chunk]);
    if (grown.length > spill.maxBytes) {
      // Keeping a prefix would advertise an incomplete file as the whole stream.
      this.spillDiscarded = true;
      this.complete = undefined;
      return;
    }
    this.complete = grown;
  }

  /**
   * Read everything captured since `fromByte`.
   * @param fromByte - a prior read's `nextOffset`, or 0 for the first read.
   * @returns the delta text, the next offset, whether the window was outrun, and the spill path.
   */
  readFrom(fromByte: number): SubprocessOutputRead {
    const windowStart = this.total - this.tail.length;
    const lossy = fromByte < windowStart;
    const slice = lossy
      ? this.tail
      : this.tail.subarray(Math.min(Math.max(fromByte - windowStart, 0), this.tail.length));
    return {
      text: slice.toString("utf8"),
      nextOffset: this.total,
      lossy,
      ...(this.spillPath !== undefined ? { spillPath: this.spillPath } : {}),
    };
  }
}
