// Simple monitoring script to help identify backend issues
const http = require('http');

const SERVER_URL = 'http://localhost:5000';
const CHECK_INTERVAL = 30000; // 30 seconds
const HEALTH_ENDPOINT = '/api/health';

let consecutiveFailures = 0;
let totalRequests = 0;
let failedRequests = 0;

console.log('🔍 Starting backend monitor...');
console.log(`📊 Checking ${SERVER_URL}${HEALTH_ENDPOINT} every ${CHECK_INTERVAL/1000} seconds`);

function checkHealth() {
  totalRequests++;
  const startTime = Date.now();
  
  const req = http.get(`${SERVER_URL}${HEALTH_ENDPOINT}`, (res) => {
    const responseTime = Date.now() - startTime;
    let data = '';
    
    res.on('data', (chunk) => {
      data += chunk;
    });
    
    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        consecutiveFailures = 0;
        
        console.log(`✅ [${new Date().toLocaleTimeString()}] Server healthy - Response: ${responseTime}ms, DB: ${response.database || 'unknown'}`);
        
        if (response.database !== 'connected') {
          console.log(`⚠️  Database state: ${response.database}`);
        }
        
      } catch (error) {
        console.log(`⚠️  [${new Date().toLocaleTimeString()}] Invalid JSON response but server responded`);
      }
    });
  });
  
  req.on('error', (error) => {
    consecutiveFailures++;
    failedRequests++;
    console.log(`❌ [${new Date().toLocaleTimeString()}] Server unreachable (${consecutiveFailures} consecutive failures)`);
    console.log(`   Error: ${error.message}`);
    
    if (consecutiveFailures >= 3) {
      console.log(`🚨 ALERT: Server has been down for ${consecutiveFailures} checks!`);
    }
  });
  
  req.setTimeout(10000, () => {
    consecutiveFailures++;
    failedRequests++;
    console.log(`⏰ [${new Date().toLocaleTimeString()}] Health check timeout`);
    req.destroy();
  });
}

// Run initial check
checkHealth();

// Set up interval
setInterval(checkHealth, CHECK_INTERVAL);

// Show stats every 5 minutes
setInterval(() => {
  const uptime = ((totalRequests - failedRequests) / totalRequests * 100).toFixed(1);
  console.log(`\n📊 STATS: ${totalRequests} total checks, ${failedRequests} failed, ${uptime}% uptime\n`);
}, 5 * 60 * 1000);

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n📴 Monitor stopping...');
  const uptime = ((totalRequests - failedRequests) / totalRequests * 100).toFixed(1);
  console.log(`Final stats: ${totalRequests} total checks, ${failedRequests} failed, ${uptime}% uptime`);
  process.exit(0);
});