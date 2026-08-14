import { describe, expect, test } from "bun:test";
import { CollectedStream } from "./output.ts";

describe("CollectedStream", () => {
  test("reads the whole stream from offset 0", () => {
    const stream = new CollectedStream({ maxBytes: 1024 });
    stream.append("hello ");
    stream.append("world");

    const read = stream.readFrom(0);
    expect(read.text).toBe("hello world");
    expect(read.nextOffset).toBe(11);
    expect(read.lossy).toBe(false);
    expect(stream.truncated).toBe(false);
  });

  test("resuming from a prior offset returns only the delta", () => {
    const stream = new CollectedStream({ maxBytes: 1024 });
    stream.append("first");
    const first = stream.readFrom(0);
    stream.append("second");

    const second = stream.readFrom(first.nextOffset);
    expect(second.text).toBe("second");
    expect(second.nextOffset).toBe(11);
    expect(second.lossy).toBe(false);
  });

  test("independent readers do not consume one another's output", () => {
    const stream = new CollectedStream({ maxBytes: 1024 });
    stream.append("abcdef");

    expect(stream.readFrom(0).text).toBe("abcdef");
    expect(stream.readFrom(0).text).toBe("abcdef");
    expect(stream.readFrom(3).text).toBe("def");
  });

  test("overflow keeps the tail and reports a stale offset as lossy", () => {
    const stream = new CollectedStream({ maxBytes: 4 });
    stream.append("abcdefghij");

    expect(stream.truncated).toBe(true);
    const read = stream.readFrom(0);
    // The window slid past offset 0, so the read is lossy and yields the tail.
    expect(read.lossy).toBe(true);
    expect(read.text).toBe("ghij");
    expect(read.nextOffset).toBe(10);

    // An offset still inside the retained window is not lossy.
    const fresh = stream.readFrom(8);
    expect(fresh.lossy).toBe(false);
    expect(fresh.text).toBe("ij");
  });

  test("byte offsets follow bytes, not characters", () => {
    const stream = new CollectedStream({ maxBytes: 1024 });
    stream.append("é"); // 2 bytes in UTF-8

    expect(stream.readFrom(0).nextOffset).toBe(2);
  });

  test("spill keeps the complete stream even once the tail overflows", () => {
    const stream = new CollectedStream({ maxBytes: 4, spill: { maxBytes: 1024 } });
    stream.append("abcdefghij");

    expect(stream.truncated).toBe(true);
    expect(stream.spillContent?.toString("utf8")).toBe("abcdefghij");
  });

  test("a stream larger than the spill cap discards the now-incomplete spill", () => {
    const stream = new CollectedStream({ maxBytes: 4, spill: { maxBytes: 6 } });
    stream.append("abcdef");
    expect(stream.spillContent?.toString("utf8")).toBe("abcdef");

    stream.append("g");
    // Keeping a prefix would advertise an incomplete file as the whole stream.
    expect(stream.spillContent).toBeUndefined();
  });

  test("no spill is retained when none was requested", () => {
    const stream = new CollectedStream({ maxBytes: 4 });
    stream.append("abcdefghij");

    expect(stream.spillContent).toBeUndefined();
    expect(stream.readFrom(0).spillPath).toBeUndefined();
  });

  test("a published spill path is surfaced to readers", () => {
    const stream = new CollectedStream({ maxBytes: 4, spill: { maxBytes: 1024 } });
    stream.append("abcdefghij");
    stream.publishSpill("/root/workspace/.dsh-createos/stdout-x.log");

    expect(stream.readFrom(0).spillPath).toBe("/root/workspace/.dsh-createos/stdout-x.log");
  });
});
