/**
 * SSE helpers for GET /api/runs/:id/stream. Replays the run's last 50
 * events on connect (Phase 2 gap 4), then streams live ones with a 15 s
 * heartbeat comment. Event line format per schema §4 examples.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { EventBus, PipelineEvent } from "../pipeline/events.js";

export const SSE_HISTORY_LIMIT = 50;
export const SSE_HEARTBEAT_MS = 15_000;

export function formatSseEvent(event: PipelineEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify({ run_id: event.runId, ...event.data })}\n\n`;
}

export function runHistory(events: EventBus, runId: string): PipelineEvent[] {
  return events
    .history(500)
    .filter((event) => event.runId === runId)
    .slice(-SSE_HISTORY_LIMIT);
}

export function streamRunEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  events: EventBus,
  runId: string,
  options: { afterSeq?: number } = {},
): void {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // A late subscriber to a finished run gets the full replay, then a clean
  // close — no dangling subscription on a run that will never emit again.
  // afterSeq honors Last-Event-ID (live stream reconnects).
  let finished = false;
  const replay = runHistory(events, runId).filter((event) => options.afterSeq === undefined || event.seq > options.afterSeq);
  for (const event of replay) {
    reply.raw.write(formatSseEvent(event));
    if (event.type === "done" || event.type === "error") finished = true;
  }
  if (finished) {
    reply.raw.end();
    return;
  }
  // Guarded write: a disconnected or finished stream must never throw
  // ERR_STREAM_WRITE_AFTER_END into the EventBus emit (process crash).
  // ponytail: single closed flag, no per-write try/catch — emit and 'close'
  // cannot interleave mid-write on one thread; upgrade to counting refs if
  // multiple writers ever share this response.
  let closed = false;
  const safeWrite = (chunk: string): void => {
    if (closed || reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(chunk);
  };
  const unsubscribe = events.subscribe((event) => {
    if (event.runId !== runId) return;
    safeWrite(formatSseEvent(event));
    if (event.type === "done" || event.type === "error") {
      cleanup();
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
  const heartbeat = setInterval(() => {
    safeWrite(": ping\n\n");
  }, SSE_HEARTBEAT_MS);
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.raw.on("close", cleanup);
}
