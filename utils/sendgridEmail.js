const sgMail = require('@sendgrid/mail');

// Configure SendGrid API key
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log('✅ SendGrid configured with API key');
} else {
  console.warn('⚠️ SendGrid API key not found - falling back to SMTP');
}

// SendGrid email function
const sendEmailWithSendGrid = async ({ email, subject, html, text, fromName }) => {
  try {
    console.log('📧 SendGrid: Sending email to:', email);

    // Generate text from HTML if not provided
    const textContent = text || html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

    const msg = {
      to: email,
      from: {
        email: process.env.FROM_EMAIL || process.env.SMTP_EMAIL,
        name: fromName || process.env.FROM_NAME || 'Leave Management System'
      },
      subject: subject,
      text: textContent,
      html: html,
      // SendGrid specific settings
      trackingSettings: {
        clickTracking: {
          enable: true,
          enableText: false
        },
        openTracking: {
          enable: true
        }
      },
      mailSettings: {
        sandboxMode: {
          enable: process.env.NODE_ENV === 'test' // Enable sandbox in test mode
        }
      }
    };

    console.log('📤 Sending via SendGrid API...');
    const response = await sgMail.send(msg);

    console.log('✅ Email sent successfully via SendGrid!');
    console.log('📧 Response status:', response[0]?.statusCode);
    console.log('📧 Message ID:', response[0]?.headers?.['x-message-id']);

    return {
      success: true,
      messageId: response[0]?.headers?.['x-message-id'],
      response: `SendGrid API - Status: ${response[0]?.statusCode}`,
      provider: 'SendGrid API',
      statusCode: response[0]?.statusCode
    };

  } catch (error) {
    console.error('❌ SendGrid email failed:', error.message);

    if (error.response?.body) {
      console.error('SendGrid error details:', JSON.stringify(error.response.body, null, 2));
    }

    throw new Error(`SendGrid email delivery failed: ${error.message}`);
  }
};

module.exports = {
  sendEmailWithSendGrid,
  isConfigured: () => !!process.env.SENDGRID_API_KEY
};