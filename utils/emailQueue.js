const { sendEmail, sendInvitationEmail } = require('./email');

// How many finished jobs to remember. A job is removed from `queue` the moment
// it is picked up, so without this the status endpoint could only ever see jobs
// that had not run yet - which is to say, never the one you wanted to ask about.
const TERMINAL_HISTORY_LIMIT = 200;

// Simple in-memory queue for email processing
class EmailQueue {
  constructor() {
    this.queue = [];
    // Finished jobs (completed | failed), newest first, capped.
    this.history = [];
    this.processing = false;
    this.processingInterval = null;
    this.nextId = 1;
  }

  // Add email job to queue
  add(jobType, data, priority = 'normal') {
    // Ids are strings and monotonic. The previous `Date.now() + Math.random()`
    // produced a float, and the status route looked it up with parseInt(), so
    // the truncated integer never matched and every lookup 404'd.
    const job = {
      id: `job_${this.nextId++}`,
      type: jobType,
      data: data,
      priority: priority,
      attempts: 0,
      maxAttempts: 3,
      createdAt: new Date(),
      status: 'pending'
    };

    // Add to front for high priority, back for normal
    if (priority === 'high') {
      this.queue.unshift(job);
    } else {
      this.queue.push(job);
    }

    console.log(`Email job queued: ${job.id} ${jobType} (priority: ${priority}, queue: ${this.queue.length})`);

    // Start processing if not already running
    this.startProcessing();

    return job.id;
  }

  /** Record a finished job so its outcome can still be queried. */
  remember(job) {
    this.history.unshift(job);
    if (this.history.length > TERMINAL_HISTORY_LIMIT) {
      this.history.length = TERMINAL_HISTORY_LIMIT;
    }
  }

  // Start processing emails in background
  startProcessing() {
    if (this.processing) return;

    this.processing = true;

    // Process queue every 2 seconds
    this.processingInterval = setInterval(() => {
      this.processNext();
    }, 2000);

    // Process first job immediately
    setImmediate(() => this.processNext());
  }

  // Stop processing
  stopProcessing() {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    this.processing = false;
  }

  // Process next job in queue
  async processNext() {
    if (this.queue.length === 0) {
      // Nothing left - drop the timer rather than waking every 2s forever.
      this.stopProcessing();
      return;
    }

    const job = this.queue.shift();
    job.status = 'processing';
    job.attempts++;

    console.log(`Processing email job: ${job.id} ${job.type} (attempt ${job.attempts}/${job.maxAttempts})`);

    try {
      let result;

      switch (job.type) {
        case 'INVITATION_EMAIL':
          result = await sendInvitationEmail(
            job.data.employee,
            job.data.token,
            job.data.inviterName,
            job.data.role
          );
          break;

        case 'GENERIC_EMAIL':
          result = await sendEmail(job.data);
          break;

        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }

      job.status = 'completed';
      job.completedAt = new Date();
      job.messageId = result && result.messageId;
      this.remember(job);

      console.log(`Email job completed: ${job.id} ${job.type}`);

    } catch (error) {
      console.error(`Email job failed: ${job.id} ${job.type} - ${error.message}`);

      job.status = 'failed';
      job.error = error.message;
      // The structured diagnosis is what makes a failure actionable in the UI,
      // so it travels with the job rather than living only in the server log.
      job.diagnosis = error.emailDiagnosis
        ? {
            title: error.emailDiagnosis.title,
            cause: error.emailDiagnosis.cause,
            solution: error.emailDiagnosis.solution,
            retryable: error.emailDiagnosis.retryable,
          }
        : null;
      job.failedAt = new Date();

      // The SMTP layer already retried transient failures internally (3
      // attempts with backoff) and refuses to retry permanent ones. Repeating
      // a permanent failure here would just multiply attempts (3 x 3) and bury
      // the real cause under duplicate noise.
      if (error.emailDiagnosis && error.emailDiagnosis.retryable === false) {
        console.error(
          `Not re-queueing: ${error.emailDiagnosis.title} - retrying cannot fix this.`
        );
        console.error(`   Fix: ${error.emailDiagnosis.solution}`);
        this.remember(job);
        return;
      }

      // Retry if attempts remaining
      if (job.attempts < job.maxAttempts) {
        job.status = 'retrying';
        console.log(`Retrying email job: ${job.id} (attempt ${job.attempts + 1}/${job.maxAttempts})`);

        // Same job object back on the queue - re-queueing a copy meant the
        // record the status endpoint had was not the one being retried.
        setTimeout(() => {
          job.status = 'pending';
          this.queue.push(job);
          this.startProcessing();
        }, 5000); // 5 second delay before retry

      } else {
        console.error(`Email job permanently failed: ${job.id} after ${job.maxAttempts} attempts`);
        this.remember(job);
      }
    }
  }

  /** Public shape of a job - never leaks the rendered email or recipient data. */
  describe(job) {
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      failedAt: job.failedAt,
      error: job.error,
      diagnosis: job.diagnosis,
      // Set by the caller when a job carries a usable fallback (e.g. an invite
      // link an admin can pass on by hand when delivery fails).
      fallbackUrl: job.data && job.data.fallbackUrl,
    };
  }

  // Get queue status
  getStatus() {
    return {
      queueSize: this.queue.length,
      processing: this.processing,
      jobs: this.queue.map((job) => this.describe(job)),
      recent: this.history.slice(0, 20).map((job) => this.describe(job)),
    };
  }

  // Get job by ID - pending or already finished.
  getJob(jobId) {
    const id = String(jobId);
    const job =
      this.queue.find((j) => j.id === id) || this.history.find((j) => j.id === id);
    return this.describe(job);
  }
}

// Create singleton instance
const emailQueue = new EmailQueue();

// Graceful shutdown
process.on('SIGTERM', () => {
  emailQueue.stopProcessing();
});

process.on('SIGINT', () => {
  emailQueue.stopProcessing();
});

module.exports = emailQueue;
