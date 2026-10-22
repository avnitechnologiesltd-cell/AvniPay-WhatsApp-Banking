import { describe, expect, it } from "vitest";

import { StdoutLogger } from "./logger";

const capture = (): { lines: string[]; write: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
};

describe("StdoutLogger", () => {
  it("writes one JSON line per record, so a log shipper needs no parser", () => {
    const sink = capture();
    const logger = new StdoutLogger({ service: "middleware", level: "info", write: sink.write });

    logger.log("listening", "Bootstrap");

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(sink.lines[0] as string)).toMatchObject({
      level: "info",
      service: "middleware",
      context: "Bootstrap",
      message: "listening",
    });
  });

  it("stamps every record with a timestamp", () => {
    const sink = capture();
    const logger = new StdoutLogger({ service: "platform", level: "info", write: sink.write });

    logger.log("up");

    const record = JSON.parse(sink.lines[0] as string) as { time: string };
    expect(Number.isNaN(Date.parse(record.time))).toBe(false);
  });

  it("drops records below the configured level", () => {
    const sink = capture();
    const logger = new StdoutLogger({ service: "platform", level: "warn", write: sink.write });

    logger.debug("noisy");
    logger.log("ordinary");
    logger.warn("worth reading");
    logger.error("worth waking up for");

    expect(sink.lines.map((line) => (JSON.parse(line) as { level: string }).level)).toEqual([
      "warn",
      "error",
    ]);
  });

  it("carries a stack trace on an error without losing the message", () => {
    const sink = capture();
    const logger = new StdoutLogger({ service: "middleware", level: "info", write: sink.write });

    logger.error("boom", "Error: boom\n    at somewhere", "Dispatch");

    expect(JSON.parse(sink.lines[0] as string)).toMatchObject({
      level: "error",
      message: "boom",
      context: "Dispatch",
      stack: "Error: boom\n    at somewhere",
    });
  });

  it("survives a message that is an object rather than a string", () => {
    const sink = capture();
    const logger = new StdoutLogger({ service: "platform", level: "info", write: sink.write });

    logger.log({ conversationId: "abc", outcome: "pending" });

    expect(JSON.parse(sink.lines[0] as string)).toMatchObject({
      message: { conversationId: "abc", outcome: "pending" },
    });
  });
});
