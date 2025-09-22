require('dotenv').config();
const axios = require('axios');

// Test the invite employee endpoint
async function testInviteEndpoint() {
  try {
    console.log('🧪 Testing invite-employee endpoint...');
    console.log('Base URL: http://localhost:5000');

    // First, login as admin to get token
    console.log('\n1. Logging in as admin...');
    const loginResponse = await axios.post('http://localhost:5000/api/auth/login', {
      email: 'qazisanaullah612@gmail.com', // Assuming this is your admin email
      password: 'password123' // Update with actual admin password
    });

    if (!loginResponse.data.token) {
      console.error('❌ Login failed - no token received');
      console.log('Response:', loginResponse.data);
      return;
    }

    console.log('✅ Admin login successful');
    const token = loginResponse.data.token;

    // Test the invite endpoint
    console.log('\n2. Testing invite-employee endpoint...');

    const inviteData = {
      name: 'Test Employee',
      email: 'test.employee@example.com',
      department: 'Engineering',
      position: 'Software Engineer',
      joinDate: new Date().toISOString().split('T')[0]
    };

    console.log('Invite data:', inviteData);
    console.log('Authorization token:', token.substring(0, 20) + '...');

    const startTime = Date.now();
    console.log('Sending request...');

    const inviteResponse = await axios.post(
      'http://localhost:5000/api/auth/invite-employee',
      inviteData,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      }
    );

    const endTime = Date.now();
    console.log(`✅ Invite request completed in ${endTime - startTime}ms`);
    console.log('Response status:', inviteResponse.status);
    console.log('Response data:', JSON.stringify(inviteResponse.data, null, 2));

  } catch (error) {
    console.error('❌ Test failed:');
    console.error('Error type:', error.constructor.name);

    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Status text:', error.response.statusText);
      console.error('Response data:', error.response.data);
    } else if (error.request) {
      console.error('Request timeout or network error');
      console.error('Request details:', error.message);
    } else {
      console.error('Error message:', error.message);
    }

    if (error.code === 'ECONNREFUSED') {
      console.error('💡 Server not running - make sure backend is started');
    } else if (error.code === 'ETIMEDOUT') {
      console.error('💡 Request timed out - endpoint may be hanging');
    }
  }
}

testInviteEndpoint();