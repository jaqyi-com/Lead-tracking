/**
 * Production effect sink: BullMQ queues on Redis + Redis pub/sub for realtime events.
 * Postgres remains the durability layer (webhook_events, sla_timers, enrollments, messages);
 * Redis is the transport, and sweepers recover anything lost.
 */
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "@lead/config";
import { JOB_QUEUE, type EffectSink, type Job, type QueueName, type RealtimeEvent } from "./effects";

export const REALTIME_CHANNEL = "lead-os:events";

export function redisConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

export const DEFAULT_JOB_OPTS = {
  attempts: 6,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  removeOnFail: { age: 14 * 24 * 3600 },
};

export class BullSink implements EffectSink {
  private queues = new Map<QueueName, Queue>();
  private pub: Redis;
  constructor(private connection: Redis = redisConnection()) {
    this.pub = connection.duplicate();
  }

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTS });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue(jobs: Job[]): Promise<void> {
    for (const j of jobs) {
      await this.queue(JOB_QUEUE[j.name]).add(j.name, j.data, {
        delay: j.opts?.delay,
        jobId: j.opts?.jobId?.replace(/:/g, "_"),
        attempts: j.opts?.attempts ?? DEFAULT_JOB_OPTS.attempts,
      });
    }
  }

  async publish(events: RealtimeEvent[]): Promise<void> {
    for (const e of events) await this.pub.publish(REALTIME_CHANNEL, JSON.stringify(e));
  }

  async close(): Promise<void> {
    for (const q of this.queues.values()) await q.close();
    this.pub.disconnect();
    this.connection.disconnect();
  }
}

/** For tests and scripts: run immediate jobs inline, keep delayed ones for manual triggering. */
export class InlineSink implements EffectSink {
  delayed: Job[] = [];
  ran: Job[] = [];
  events: RealtimeEvent[] = [];
  failures: { job: Job; error: unknown }[] = [];
  constructor(private opts: { runDelayed?: boolean; skip?: string[] } = {}) {}

  async enqueue(jobs: Job[]): Promise<void> {
    const { runJob } = await import("./jobs");
    for (const j of jobs) {
      if (this.opts.skip?.includes(j.name)) continue;
      if (j.opts?.delay && j.opts.delay > 0 && !this.opts.runDelayed) {
        this.delayed.push(j);
        continue;
      }
      this.ran.push(j);
      try {
        await runJob(j.name, j.data);
      } catch (error) {
        this.failures.push({ job: j, error });
      }
    }
  }

  async publish(events: RealtimeEvent[]): Promise<void> {
    this.events.push(...events);
  }

  async runDelayed(filter?: (j: Job) => boolean): Promise<number> {
    const { runJob } = await import("./jobs");
    const due = this.delayed.filter((j) => !filter || filter(j));
    this.delayed = this.delayed.filter((j) => !due.includes(j));
    for (const j of due) {
      this.ran.push(j);
      await runJob(j.name, j.data);
    }
    return due.length;
  }
}
