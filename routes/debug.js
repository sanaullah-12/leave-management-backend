const express = require('express');
const router = express.Router();

// Debug endpoint to check environment variables
router.get('/email-config', (req, res) => {
  const emailConfig = {
    environment: process.env.NODE_ENV,
    timestamp: new Date().toISOString(),
    email_variables: {
      SMTP_HOST: !!process.env.SMTP_HOST,
      SMTP_PORT: !!process.env.SMTP_PORT,
      SMTP_EMAIL: !!process.env.SMTP_EMAIL,
      SMTP_PASSWORD: !!process.env.SMTP_PASSWORD,
      FROM_EMAIL: !!process.env.FROM_EMAIL,
      FROM_NAME: !!process.env.FROM_NAME,
      SendGrid_Key: !!process.env.SendGrid_Key,
      SENDGRID_API_KEY: !!process.env.SENDGRID_API_KEY,
    },
    email_values: {
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_EMAIL: process.env.SMTP_EMAIL,
      SMTP_PASSWORD: process.env.SMTP_PASSWORD ? `${process.env.SMTP_PASSWORD.substring(0, 4)}...` : 'NOT SET',
      FROM_EMAIL: process.env.FROM_EMAIL,
      FROM_NAME: process.env.FROM_NAME,
      SendGrid_Key: process.env.SendGrid_Key ? `${process.env.SendGrid_Key.substring(0, 10)}...` : 'NOT SET',
      FRONTEND_URL: process.env.FRONTEND_URL
    },
    email_logic: {
      isProduction: process.env.NODE_ENV === 'production',
      sendGridConfigured: !!(process.env.SendGrid_Key && process.env.SendGrid_Key !== 'your_sendgrid_api_key_here' && process.env.SendGrid_Key.length > 10),
      willUseSendGrid: process.env.NODE_ENV === 'production' && !!(process.env.SendGrid_Key && process.env.SendGrid_Key !== 'your_sendgrid_api_key_here' && process.env.SendGrid_Key.length > 10),
      smtpConfigured: !!(process.env.SMTP_HOST && process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD)
    }
  };

  res.json(emailConfig);
});

// Test email endpoint
router.post('/test-email', async (req, res) => {
  try {
    const { sendEmail } = require('../utils/email');

    const result = await sendEmail({
      email: req.body.email || 'test@example.com',
      subject: 'Production Email Test',
      html: '<h2>Production Test</h2><p>This is a test email from production environment.</p>',
      text: 'Production Test - This is a test email from production environment.',
      category: 'test'
    });

    res.json({
      success: true,
      message: 'Test email sent successfully',
      result: result
    });

  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({
      success: false,
      message: 'Test email failed',
      error: error.message,
      details: error.stack
    });
  }
});

module.exports = router;