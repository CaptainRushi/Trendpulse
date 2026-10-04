/**
 * In-process pipeline event bus (feeds the Phase 7 SSE channel).
 * Orchestrator stages emit `stage` / `source` / `progress` / `log` /
 * `done` / `error`; the API layer subscribes. A bounded history (latest
 * 500) lets SSE replay recent events on connect (Phase 2 gap 4).
 */
export type PipelineEventType =
  | "stage"
  | "source"
  | "progress"
  | "log"
  | "done"
  | "error"
  | "sample"
  | "top_changed"
  | "cycle";

export interface PipelineEvent {
  seq: number;
  runId: string;
  type: PipelineEventType;
  at: string;
  data: Record<string, unknown>;
}

export type PipelineEventHandler = (event: PipelineEvent) => void;

/** Ring buffer cap — comfortably above the 50-event SSE replay needs. */
export const EVENT_HISTORY_LIMIT = 500;

export class EventBus {
  private readonly handlers = new Set<PipelineEventHandler>();
  private readonly past: PipelineEvent[] = [];
  private nextSeq = 1;

  subscribe(handler: PipelineEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(runId: string, type: PipelineEventType, data: Record<string, unknown> = {}): PipelineEvent {
    const event: PipelineEvent = {
      seq: this.nextSeq++,
      runId,
      type,
      at: new Date().toISOString(),
      data,
    };
    this.past.push(event);
    if (this.past.length > EVENT_HISTORY_LIMIT) this.past.shift();
    for (const handler of this.handlers) handler(event);
    return event;
  }

  /** Newest last. Phase 7 replays the tail on SSE connect. */
  history(limit = 50): PipelineEvent[] {
    return this.past.slice(Math.max(0, this.past.length - limit));
  }
}

/** Process-wide bus: the orchestrator emits here, the API subscribes here. */
export const pipelineBus = new EventBus();
