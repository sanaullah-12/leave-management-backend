// Email deliverability best practices and validation
const crypto = require('crypto');

const validateEmailContent = (content) => {
  // Check for spam trigger words and phrases
  const spamTriggers = [
    'free', 'win', 'winner', 'congratulations', 'urgent', 'act now',
    'limited time', 'exclusive', 'guarantee', 'no cost', 'risk free',
    'amazing', 'incredible', 'fantastic deal', 'once in a lifetime',
    'cash', 'money back', 'earn money', 'make money fast',
    'click here', 'click now', 'buy now', 'order now',
    'viagra', 'cialis', 'loan', 'credit', 'refinance'
  ];
  
  const lowercaseContent = content.toLowerCase();
  const foundTriggers = spamTriggers.filter(trigger => 
    lowercaseContent.includes(trigger)
  );
  
  return {
    isClean: foundTriggers.length === 0,
    triggers: foundTriggers,
    score: Math.max(0, 100 - (foundTriggers.length * 10))
  };
};

const generateEmailHeaders = (messageType = 'transactional') => {
  return {
    'List-Unsubscribe': '<mailto:unsubscribe@leavemanagement.com>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Precedence': messageType === 'transactional' ? 'bulk' : 'list',
    'Auto-Submitted': 'auto-generated',
    'X-Mailer': 'Leave Management System v1.0',
    'Message-ID': `<${crypto.randomUUID()}@leavemanagement.com>`,
    'MIME-Version': '1.0',
    'Content-Type': 'multipart/alternative'
  };
};

const sanitizeSubjectLine = (subject) => {
  // Remove excessive punctuation
  let clean = subject.replace(/[!]{2,}/g, '!').replace(/[?]{2,}/g, '?');
  
  // Remove excessive capital letters
  const capsCount = (clean.match(/[A-Z]/g) || []).length;
  const totalChars = clean.replace(/\s/g, '').length;
  const capsRatio = capsCount / totalChars;
  
  if (capsRatio > 0.5) {
    // Too many caps, convert to title case
    clean = clean.toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
  }
  
  // Ensure subject is not too short or too long
  if (clean.length < 10) {
    clean = `${clean} - Leave Management System`;
  }
  if (clean.length > 78) {
    clean = clean.substring(0, 75) + '...';
  }
  
  return clean;
};

const buildTextVersion = (html) => {
  // Convert HTML to plain text with proper formatting
  let text = html
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Convert HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up whitespace
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
    
  // Add proper line breaks for readability
  text = text
    .replace(/\. /g, '.\n')
    .replace(/: /g, ':\n')
    .replace(/\n{3,}/g, '\n\n');
    
  return text;
};

const getOptimalSendTime = () => {
  const now = new Date();
  const hour = now.getHours();
  
  // Best times for business emails: 9-11 AM and 2-4 PM on weekdays
  const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
  const isOptimalHour = (hour >= 9 && hour <= 11) || (hour >= 14 && hour <= 16);
  
  if (!isWeekday || !isOptimalHour) {
    // Schedule for next optimal time
    const nextSend = new Date(now);
    if (now.getDay() === 0) { // Sunday
      nextSend.setDate(now.getDate() + 1); // Monday
    } else if (now.getDay() === 6) { // Saturday
      nextSend.setDate(now.getDate() + 2); // Monday
    } else if (hour < 9) {
      // Same day, 9 AM
      nextSend.setHours(9, 0, 0, 0);
    } else if (hour >= 17) {
      // Next day, 9 AM
      nextSend.setDate(now.getDate() + 1);
      nextSend.setHours(9, 0, 0, 0);
    } else {
      // Same day, 2 PM
      nextSend.setHours(14, 0, 0, 0);
    }
    
    return {
      shouldDelay: true,
      sendAt: nextSend,
      reason: 'Scheduling for optimal delivery time'
    };
  }
  
  return {
    shouldDelay: false,
    sendAt: now,
    reason: 'Sending immediately - optimal time'
  };
};

const enhanceEmailForDeliverability = (emailOptions) => {
  const enhanced = { ...emailOptions };
  
  // Sanitize subject line
  enhanced.subject = sanitizeSubjectLine(enhanced.subject);
  
  // Validate content
  const contentValidation = validateEmailContent(enhanced.html);
  if (!contentValidation.isClean) {
    console.warn('⚠️ Email content contains potential spam triggers:', contentValidation.triggers);
  }
  
  // Add headers for better deliverability
  enhanced.headers = {
    ...generateEmailHeaders(enhanced.category || 'transactional'),
    ...enhanced.headers
  };
  
  // Ensure proper text version exists
  if (!enhanced.text) {
    enhanced.text = buildTextVersion(enhanced.html);
  }
  
  // Add authentication and reputation headers
  enhanced.mailSettings = {
    spamCheck: {
      enable: true,
      threshold: 1
    },
    ...enhanced.mailSettings
  };
  
  // Disable tracking for better deliverability
  enhanced.trackingSettings = {
    clickTracking: { enable: false },
    openTracking: { enable: false },
    subscriptionTracking: { enable: false },
    ...enhanced.trackingSettings
  };
  
  // Add categories for SendGrid analytics
  enhanced.categories = [
    'leave-management',
    enhanced.category || 'general',
    process.env.NODE_ENV || 'development'
  ];
  
  return {
    enhanced,
    validation: contentValidation,
    timing: getOptimalSendTime()
  };
};

const getDeliverabilityTips = () => {
  return [
    "📧 SENDER REPUTATION:",
    "• Use a verified domain email address (not Gmail/Yahoo)",
    "• Set up SPF, DKIM, and DMARC records for your domain",
    "• Maintain consistent sending patterns",
    "",
    "📝 CONTENT BEST PRACTICES:",
    "• Keep subject lines between 30-50 characters",
    "• Include both HTML and plain text versions",
    "• Avoid spam trigger words and excessive punctuation",
    "• Use proper HTML structure with DOCTYPE",
    "",
    "⚡ TECHNICAL SETUP:",
    "• Authenticate with SendGrid using API keys",
    "• Use dedicated IP if sending high volume",
    "• Monitor bounce and complaint rates",
    "• Include unsubscribe links for compliance",
    "",
    "⏰ TIMING:",
    "• Send during business hours (9-11 AM, 2-4 PM)",
    "• Avoid weekends and holidays",
    "• Respect recipient time zones",
    "",
    "🔍 MONITORING:",
    "• Check SendGrid delivery statistics",
    "• Monitor inbox placement rates",
    "• Test with multiple email providers",
    "• Set up feedback loops for bounces"
  ];
};

module.exports = {
  validateEmailContent,
  generateEmailHeaders,
  sanitizeSubjectLine,
  buildTextVersion,
  getOptimalSendTime,
  enhanceEmailForDeliverability,
  getDeliverabilityTips
};