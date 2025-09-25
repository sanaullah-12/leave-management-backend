const { sendEmail, sendInvitationEmail } = require('./email');

// Simple in-memory queue for email processing
class EmailQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.processingInterval = null;
  }

  // Add email job to queue
  add(jobType, data, priority = 'normal') {
    const job = {
      id: Date.now() + Math.random(),
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

    console.log(`📬 Email job added to queue: ${jobType} (Priority: ${priority})`);
    console.log(`📊 Queue size: ${this.queue.length}`);

    // Start processing if not already running
    this.startProcessing();

    return job.id;
  }

  // Start processing emails in background
  startProcessing() {
    if (this.processing) return;

    this.processing = true;
    console.log('🚀 Email queue processing started');

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
    console.log('🛑 Email queue processing stopped');
  }

  // Process next job in queue
  async processNext() {
    if (this.queue.length === 0) return;

    const job = this.queue.shift();
    job.status = 'processing';
    job.attempts++;

    console.log(`📧 Processing email job: ${job.type} (Attempt ${job.attempts}/${job.maxAttempts})`);

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
      job.result = result;

      console.log(`✅ Email job completed: ${job.type}`);
      console.log(`📧 Message ID: ${result.messageId}`);

    } catch (error) {
      console.error(`❌ Email job failed: ${job.type} - ${error.message}`);

      job.status = 'failed';
      job.error = error.message;
      job.failedAt = new Date();

      // Retry if attempts remaining
      if (job.attempts < job.maxAttempts) {
        job.status = 'retrying';
        console.log(`🔄 Retrying email job: ${job.type} (Attempt ${job.attempts + 1}/${job.maxAttempts})`);

        // Add back to queue with delay
        setTimeout(() => {
          this.queue.push({
            ...job,
            status: 'pending'
          });
        }, 5000); // 5 second delay before retry

      } else {
        console.error(`💀 Email job permanently failed: ${job.type} after ${job.maxAttempts} attempts`);
      }
    }
  }

  // Get queue status
  getStatus() {
    return {
      queueSize: this.queue.length,
      processing: this.processing,
      jobs: this.queue.map(job => ({
        id: job.id,
        type: job.type,
        status: job.status,
        attempts: job.attempts,
        createdAt: job.createdAt
      }))
    };
  }

  // Get job by ID
  getJob(jobId) {
    return this.queue.find(job => job.id === jobId);
  }
}

// Create singleton instance
const emailQueue = new EmailQueue();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('📪 Gracefully shutting down email queue...');
  emailQueue.stopProcessing();
});

process.on('SIGINT', () => {
  console.log('📪 Gracefully shutting down email queue...');
  emailQueue.stopProcessing();
});

module.exports = emailQueue;