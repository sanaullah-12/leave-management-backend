const { spawn } = require('child_process');
const path = require('path');

// Simple process manager for development
let serverProcess = null;
let restartCount = 0;
const maxRestarts = 5;

function startServer() {
  console.log(`Starting server (attempt ${restartCount + 1}/${maxRestarts})...`);
  
  serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'inherit'
  });

  serverProcess.on('close', (code) => {
    console.log(`\n Server process exited with code ${code}`);
    
    if (code !== 0 && restartCount < maxRestarts) {
      restartCount++;
      console.log(`Restarting server in 3 seconds... (${restartCount}/${maxRestarts})`);
      setTimeout(startServer, 3000);
    } else if (restartCount >= maxRestarts) {
      console.log(`Max restart attempts (${maxRestarts}) reached. Please check the logs.`);
      process.exit(1);
    } else {
      console.log('Server shut down gracefully');
      process.exit(0);
    }
  });

  serverProcess.on('error', (error) => {
    console.error(`Failed to start server:`, error);
  });
}

// Handle shutdown signals
process.on('SIGINT', () => {
  console.log('\n Received SIGINT. Shutting down gracefully...');
  if (serverProcess) {
    serverProcess.kill('SIGINT');
  }
});

process.on('SIGTERM', () => {
  console.log('\n Received SIGTERM. Shutting down gracefully...');
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
});

console.log('Starting Leave Management Server with Auto-Restart...');
startServer();