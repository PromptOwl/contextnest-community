/**
 * The live side of the harness (PO-1200 AC-C3-12, C2 PO-1197): one event
 * stream per nest while the tab is visible, with polling as the source of
 * truth underneath; presence heartbeats and the list of who is around; the
 * typing signal out and the typing line in. The rules are in
 * lib/chat-live.ts; this file is the browser plumbing around them.
 *
 * The stream is read with `fetch` rather than `EventSource` so the server's
 * `: ping` comments are visible: 45 s of silence means the connection is
 * dead and is reopened. A failed open backs off (5 s, 10 s, … 60 s) and the
 * usual poll carries on meanwhile.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../../lib/api";
import {
  STREAM_SILENCE_MS,
  applyPresence,
  chatEffects,
  heartbeatDue,
  onlineSet,
  parseSse,
  pruneTyping,
  typingDue,
  typingLine,
  type ChatEffect,
  type ChatEvent,
  type PresenceRow,
} from "../../lib/chat-live";
import { keys, reads } from "../../lib/queries";

function useVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return visible;
}

/**
 * Open the nest's event stream and hand each event to `onEffects`. Returns
 * whether the stream is up (the poll slows down while it is).
 */
export function useChatEvents(nestId: string | null, enabled: boolean, onEffects: (effects: ChatEffect[], event: ChatEvent) => void, ctx: { me: string | null; openKey: string | null }) {
  const [connected, setConnected] = useState(false);
  const visible = useVisible();
  const handler = useRef(onEffects);
  handler.current = onEffects;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    if (!nestId || !enabled || !visible) {
      setConnected(false);
      return;
    }
    let stopped = false;
    let controller: AbortController | null = null;
    let backoff = 5_000;
    let lastId: string | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const alive = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => controller?.abort(), STREAM_SILENCE_MS);
    };
    const later = () => {
      if (stopped) return;
      retry = setTimeout(open, backoff);
      backoff = Math.min(60_000, backoff * 2);
    };
    const open = async () => {
      if (stopped) return;
      controller = new AbortController();
      try {
        const res = await fetch(api.chatEventsUrl(nestId), {
          headers: { Accept: "text/event-stream", ...(lastId ? { "Last-Event-ID": lastId } : {}) },
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          // 404: not a member or chat off — nothing to stream; stop trying.
          if (res.status === 404 || res.status === 403) return;
          later();
          return;
        }
        setConnected(true);
        backoff = 5_000;
        alive();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          alive();
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          for (const f of parsed.frames) {
            if (f.id) lastId = f.id;
            let data: unknown = null;
            try {
              data = JSON.parse(f.data);
            } catch {
              continue;
            }
            const event = { event: f.event, data } as ChatEvent;
            handler.current(chatEffects(event, ctxRef.current), event);
          }
        }
      } catch {
        /* aborted or dropped: reopen below */
      }
      setConnected(false);
      if (!stopped) later();
    };
    void open();
    return () => {
      stopped = true;
      setConnected(false);
      controller?.abort();
      if (retry) clearTimeout(retry);
      if (watchdog) clearTimeout(watchdog);
    };
  }, [nestId, enabled, visible]);

  return connected;
}

/** Who is around: a heartbeat for me, the list for everyone, patched by events. */
export function usePresence(nestId: string | null, enabled: boolean) {
  const qc = useQueryClient();
  const visible = useVisible();
  const last = useRef<number | null>(null);
  const list = useQuery({ ...reads.presence(nestId ?? ""), enabled: !!nestId && enabled, refetchInterval: visible ? 60_000 : false });

  useEffect(() => {
    if (!nestId || !enabled) return;
    let stopped = false;
    const beat = () => {
      if (stopped || !heartbeatDue(last.current, Date.now(), document.visibilityState !== "hidden")) return;
      last.current = Date.now();
      api.heartbeatPresence(nestId).catch(() => undefined);
    };
    beat();
    const t = setInterval(beat, 30_000);
    const onVisible = () => beat();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [nestId, enabled]);

  const patch = useCallback(
    (e: { email: string; agent: string | null; status: string | null; active: boolean }) => {
      if (!nestId) return;
      qc.setQueryData<{ active: PresenceRow[]; expires_in: number }>(keys.presence(nestId), (d) => (d ? { ...d, active: applyPresence(d.active, e) } : d));
    },
    [qc, nestId],
  );
  const online = useMemo(() => onlineSet(list.data?.active ?? []), [list.data]);
  return { online, active: list.data?.active ?? [], patch };
}

/** The typing signal out (at most one per 3 s per container) and the line in. */
export function useTyping(nestId: string | null, containerNodeId: string | null) {
  const sent = useRef<{ key: string; at: number } | null>(null);
  const [typists, setTypists] = useState<Map<string, number>>(() => new Map());
  const onType = useCallback(() => {
    if (!nestId || !containerNodeId) return;
    const now = Date.now();
    if (sent.current?.key === containerNodeId && !typingDue(sent.current.at, now)) return;
    sent.current = { key: containerNodeId, at: now };
    api.sendTyping(nestId, containerNodeId).catch(() => undefined);
  }, [nestId, containerNodeId]);
  const heard = useCallback((key: string, who: string) => {
    setTypists((m) => {
      const next = new Map(m);
      next.set(`${key}|${who}`, Date.now());
      return next;
    });
  }, []);
  // Drop stale typists; the clear is the only timer, and it moves nothing.
  useEffect(() => {
    if (typists.size === 0) return;
    const t = setTimeout(() => setTypists((m) => new Map([...m].filter(([, at]) => Date.now() - at < 5_000))), 5_200);
    return () => clearTimeout(t);
  }, [typists]);
  const line = useCallback(
    (key: string | null) => {
      if (!key) return null;
      const names = pruneTyping(new Map([...typists].filter(([k]) => k.startsWith(`${key}|`)).map(([k, at]) => [k.slice(key.length + 1), at])), Date.now());
      return typingLine(names);
    },
    [typists],
  );
  // Clear what was shown once the container changes.
  useEffect(() => {
    setTypists(new Map());
  }, [containerNodeId]);
  return { onType, heard, line };
}
