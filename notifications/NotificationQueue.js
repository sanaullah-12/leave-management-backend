/**
 * NotificationQueue.js
 * --------------------
 * A bounded, concurrent, retrying in-process job queue.
 *
 * Why a queue at all: an outbound WhatsApp call is a network round trip to a
 * third party. Doing it inline would put a vendor's latency (and outages) on
 * the critical path of "submit leave request". Enqueuing makes delivery
 * asynchronous and, crucially, *retryable* - a 30-second provider blip becomes
 * a delayed message instead of a lost one.
 *
 * Design notes:
 *   - Handlers are registered by job type, so the queue knows nothing about
 *     WhatsApp. Adding SMS or Slack later means registering another handler.
 *   - Failures are classified. `error.retryable === false` (a bad token, an
 *     invalid recipient) is a dead letter immediately; retrying it would only
 *     multiply noise, exactly the trap the email queue documents.
 *   - Backoff is exponential with jitter, so a provider recovering from an
 *     outage is not hit by every queued job at the same instant.
 *   - The buffer is bounded. Under a long outage the oldest pending job is
 *     dropped and counted rather than growing until the process dies.
 *
 * This is deliberately in-process, matching the existing email queue. The
 * handler interface is the seam: pointing `enqueue` at BullMQ/Redis later is a
 * change inside this file only. See the documentation for the migration note.
 */

const config = require("./config");
const logger = require("./NotificationLogger");

let jobSequence = 0;

const nextJobId = () => {
  jobSequence += 1;
  return `job_${Date.now().toString(36)}_${jobSequence.toString(36)}`;
};

class NotificationQueue {
  constructor(options = {}) {
    this.settings = { ...config.queue, ...options };

    /** Jobs waiting for a worker slot. High priority is unshifted to the front. */
    this.pending = [];
    /** Job ids currently executing, to enforce the concurrency cap. */
    this.active = new Set();
    /** Retry timers, tracked so shutdown can clear them. */
    this.timers = new Set();
    /** type -> async handler(payload, job) */
    this.handlers = new Map();

    this.stopped = false;

    this.stats = {
      enqueued: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      deadLettered: 0,
      dropped: 0,
    };

    /** Recently finished jobs, newest first, for the ops endpoint. */
    this.history = [];
  }

  /** Registers the worker for a job type. Re-registering replaces it. */
  register(type, handler) {
    if (typeof handler !== "function") {
      throw new TypeError(`Handler for "${type}" must be a function`);
    }
    this.handlers.set(type, handler);
    return this;
  }

  /**
   * Adds a job and returns its id immediately. Never throws and never awaits
   * delivery: callers are on a request path and must not be blocked.
   */
  enqueue(type, payload, options = {}) {
    if (this.stopped) {
      logger.warn("Queue is stopped, job rejected", { type });
      return null;
    }

    if (!this.handlers.has(type)) {
      logger.error("No handler registered for job type", { type });
      return null;
    }

    if (this.pending.length >= this.settings.maxSize) {
      // Shed the oldest normal-priority work first: a stale notification is
      // worth less than a fresh one, and unbounded growth is worse than both.
      const dropped = this.pending.shift();
      this.stats.dropped += 1;
      logger.error("Queue is full, dropped the oldest pending job", {
        type: dropped?.type,
        jobId: dropped?.id,
        queueSize: this.pending.length,
      });
    }

    const job = {
      id: nextJobId(),
      type,
      payload,
      priority: options.priority === "high" ? "high" : "normal",
      attempts: 0,
      maxAttempts: options.maxAttempts || this.settings.maxAttempts,
      correlationId: options.correlationId || null,
      createdAt: new Date(),
      status: "pending",
      lastError: null,
    };

    if (job.priority === "high") this.pending.unshift(job);
    else this.pending.push(job);

    this.stats.enqueued += 1;
    logger.debug("Job enqueued", {
      jobId: job.id,
      type,
      correlationId: job.correlationId,
      queueSize: this.pending.length,
    });

    // Drain on the next tick so a caller that enqueues several jobs in a row
    // finishes its synchronous work before any handler runs.
    setImmediate(() => this.pump());
    return job.id;
  }

  /** Starts as many jobs as the concurrency cap allows. */
  pump() {
    if (this.stopped) return;

    while (this.active.size < this.settings.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      this.run(job);
    }
  }

  async run(job) {
    this.active.add(job.id);
    job.attempts += 1;
    job.status = "processing";
    job.startedAt = new Date();

    const handler = this.handlers.get(job.type);

    try {
      const result = await handler(job.payload, job);

      job.status = "completed";
      job.completedAt = new Date();
      job.result = result;
      this.stats.completed += 1;

      logger.debug("Job completed", {
        jobId: job.id,
        type: job.type,
        attempts: job.attempts,
        correlationId: job.correlationId,
      });

      this.remember(job);
    } catch (error) {
      job.lastError = error.message;
      this.stats.failed += 1;

      const retryable = error.retryable !== false;
      const attemptsLeft = job.attempts < job.maxAttempts;

      if (retryable && attemptsLeft) {
        this.scheduleRetry(job, error);
      } else {
        job.status = "dead";
        job.failedAt = new Date();
        this.stats.deadLettered += 1;

        logger.error("Job permanently failed", {
          jobId: job.id,
          type: job.type,
          attempts: job.attempts,
          correlationId: job.correlationId,
          reason: retryable ? "attempts exhausted" : "not retryable",
          error: error.message,
        });

        this.remember(job);
      }
    } finally {
      this.active.delete(job.id);
      // Free slot: pull the next job in without waiting for a new enqueue.
      setImmediate(() => this.pump());
    }
  }

  /**
   * Exponential backoff with full jitter.
   * The jitter matters: without it every job queued during an outage retries
   * in lockstep and re-creates the load that caused the outage.
   */
  backoffFor(attempt) {
    const exponential = this.settings.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(exponential, this.settings.maxDelayMs);
    return Math.round(capped / 2 + Math.random() * (capped / 2));
  }

  scheduleRetry(job, error) {
    const delay = this.backoffFor(job.attempts);
    job.status = "retrying";
    this.stats.retried += 1;

    logger.warn("Job failed, scheduling retry", {
      jobId: job.id,
      type: job.type,
      attempt: `${job.attempts}/${job.maxAttempts}`,
      retryInMs: delay,
      correlationId: job.correlationId,
      error: error.message,
    });

    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.stopped) return;
      job.status = "pending";
      this.pending.unshift(job); // Retries jump the queue - they are already late.
      this.pump();
    }, delay);

    // Do not hold the event loop open purely for a pending retry.
    if (typeof timer.unref === "function") timer.unref();
    this.timers.add(timer);
  }

  remember(job) {
    this.history.unshift({
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      correlationId: job.correlationId,
      createdAt: job.createdAt,
      finishedAt: job.completedAt || job.failedAt,
      error: job.lastError,
    });
    if (this.history.length > this.settings.historySize) this.history.pop();
  }

  getStats() {
    return {
      ...this.stats,
      pending: this.pending.length,
      active: this.active.size,
      scheduledRetries: this.timers.size,
      concurrency: this.settings.concurrency,
      maxSize: this.settings.maxSize,
      handlers: [...this.handlers.keys()],
    };
  }

  getHistory(limit = 25) {
    return this.history.slice(0, limit);
  }

  /**
   * Waits until the queue is idle. Used by graceful shutdown and by tests;
   * never called from a request path.
   */
  async drain({ timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    // A job waiting on a retry timer is neither pending nor active. Ignoring
    // those would report "idle" while retries are still owed, and shutdown
    // would then clear their timers and lose the messages.
    while (
      this.pending.length > 0 ||
      this.active.size > 0 ||
      this.timers.size > 0
    ) {
      if (Date.now() > deadline) {
        logger.warn("Queue drain timed out", this.getStats());
        return false;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

// One shared instance: the queue is process-wide state, like the email queue.
const notificationQueue = new NotificationQueue();

const shutdown = async (signal) => {
  logger.info("Draining notification queue before shutdown", { signal });
  await notificationQueue.drain({ timeoutMs: 5000 });
  notificationQueue.stop();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = notificationQueue;
module.exports.NotificationQueue = NotificationQueue;
