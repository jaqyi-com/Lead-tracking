/**
 * Side effects (queue jobs, realtime events) are buffered during a DB transaction and flushed only
 * after commit, so a rolled-back transaction never enqueues work or pushes a phantom update.
 */
import { getDb, type Db } from "@lead/db";

export type QueueName = "ingest" | "outbound" | "default";

export type JobName =
  | "ingest.process"
  | "media.fetch"
  | "outbound.send"
  | "outbound.simulate_status"
  | "sla.check"
  | "cadence.run"
  | "lead.enrich"
  | "lead.score"
  | "notify.push"
  | "notify.email"
  | "mailbox.sync"
  | "broadcast.fanout"
  | "conversation.unsnooze";

export const JOB_QUEUE: Record<JobName, QueueName> = {
  "ingest.process": "ingest",
  "media.fetch": "ingest",
  "mailbox.sync": "ingest",
  "outbound.send": "outbound",
  "outbound.simulate_status": "outbound",
  "broadcast.fanout": "outbound",
  "sla.check": "default",
  "cadence.run": "default",
  "lead.enrich": "default",
  "lead.score": "default",
  "notify.push": "default",
  "notify.email": "default",
  "conversation.unsnooze": "default",
};

export type Job = {
  name: JobName;
  data: Record<string, unknown>;
  opts?: { delay?: number; jobId?: string; attempts?: number };
};

export type RealtimeEvent = {
  type:
    | "message.created"
    | "message.updated"
    | "conversation.updated"
    | "lead.created"
    | "lead.updated"
    | "notification"
    | "presence";
  orgId: string;
  leadId?: string;
  conversationId?: string;
  messageId?: string;
  userIds?: string[];
  data?: Record<string, unknown>;
};

export interface EffectSink {
  enqueue(jobs: Job[]): Promise<void>;
  publish(events: RealtimeEvent[]): Promise<void>;
}

class NoopSink implements EffectSink {
  async enqueue(): Promise<void> {}
  async publish(): Promise<void> {}
}

let sink: EffectSink = new NoopSink();

export function setEffectSink(s: EffectSink): void {
  sink = s;
}

export function getEffectSink(): EffectSink {
  return sink;
}

export class Fx {
  jobs: Job[] = [];
  events: RealtimeEvent[] = [];

  enqueue(name: JobName, data: Record<string, unknown>, opts?: Job["opts"]): void {
    this.jobs.push({ name, data, opts });
  }

  /** Enqueue to run at a given time (delay computed at flush). */
  enqueueAt(name: JobName, data: Record<string, unknown>, at: Date, jobId?: string): void {
    this.jobs.push({ name, data, opts: { delay: Math.max(0, at.getTime() - Date.now()), jobId } });
  }

  publish(event: RealtimeEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<void> {
    const jobs = this.jobs;
    const events = this.events;
    this.jobs = [];
    this.events = [];
    if (jobs.length) await sink.enqueue(jobs);
    if (events.length) await sink.publish(events);
  }
}

/** Run fn in a transaction; flush its effects after commit. */
export async function withTx<T>(fn: (tx: Db, fx: Fx) => Promise<T>, db: Db = getDb()): Promise<T> {
  const fx = new Fx();
  const result = await db.transaction(async (tx) => fn(tx as unknown as Db, fx));
  await fx.flush();
  return result;
}
