/** Live run events over SSE. Reconnects with backoff; exposes health. */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

export interface RunEvent {
  run_id: string;
  type: string;
  [key: string]: unknown;
}

export interface EventSourceState {
  events: RunEvent[];
  connected: boolean;
}

export function useRunEvents(runId: string | null): EventSourceState {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);
  const client = useQueryClient();

  useEffect(() => {
    if (!runId || typeof EventSource === "undefined") return;
    setEvents([]);
    let source: EventSource | null = null;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (closed) return;
      source = new EventSource(`/api/runs/${runId}/stream`);
      source.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
      };
      source.onmessage = (message: MessageEvent<string>) => {
        try {
          const data = JSON.parse(message.data) as RunEvent;
          setEvents((prev) => [...prev.slice(-199), data]);
        } catch {
          // Malformed frame — ignore, the next heartbeat follows.
        }
      };
      // Custom event types arrive via listeners, not onmessage. The event
      // name is the type — data carries no `type` field (server sends
      // {run_id, ...payload}), so close on the listener name, not the data.
      for (const type of ["stage", "source", "progress", "log", "done", "error"]) {
        source.addEventListener(type, ((event: Event) => {
          const message = event as MessageEvent<string>;
          try {
            const data = JSON.parse(message.data) as RunEvent;
            setEvents((prev) => [...prev.slice(-199), data]);
            // Stage changes move the FlowStrip live (esp. the sorter stages).
            if (type === "stage" || type === "done" || type === "error") {
              void client.invalidateQueries({ queryKey: ["run", runId] });
            }
            if (type === "done" || type === "error") source?.close();
          } catch {
            // Ignore malformed frames.
          }
        }) as EventListener);
      }
      source.onerror = () => {
        setConnected(false);
        source?.close();
        const backoff = Math.min(1000 * 2 ** retryRef.current, 15000);
        retryRef.current += 1;
        timer = setTimeout(connect, backoff);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, [runId]);

  return { events, connected };
}
