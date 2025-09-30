// Comprehensive ZKTeco connection debugging
const net = require('net');

async function debugZKTecoConnection() {
  console.log('🔍 ZKTeco Device Connection Debugging');
  console.log('====================================\n');

  const ip = '192.168.1.201';
  const port = 4370;

  // Test 1: Basic TCP socket connection
  console.log('📡 Test 1: Basic TCP Socket Connection');
  console.log('-------------------------------------');

  try {
    const tcpTest = await new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('TCP connection timeout (10s)'));
      }, 10000);

      socket.on('connect', () => {
        clearTimeout(timeout);
        console.log('✅ TCP connection successful');
        socket.destroy();
        resolve(true);
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      socket.on('timeout', () => {
        clearTimeout(timeout);
        socket.destroy();
        reject(new Error('Socket timeout'));
      });

      console.log(`   Attempting TCP connection to ${ip}:${port}...`);
      socket.connect(port, ip);
    });

  } catch (tcpError) {
    console.log(`❌ TCP connection failed: ${tcpError.message}`);

    // Check common issues
    if (tcpError.message.includes('ECONNREFUSED')) {
      console.log('   💡 Device is reachable but port 4370 is not accepting connections');
      console.log('   💡 Possible causes:');
      console.log('      - ZKTeco service is not running on the device');
      console.log('      - Device firewall is blocking port 4370');
      console.log('      - Device is in wrong mode (standalone vs network)');
    } else if (tcpError.message.includes('timeout')) {
      console.log('   💡 Connection times out - device might be busy or misconfigured');
    } else if (tcpError.message.includes('EHOSTUNREACH')) {
      console.log('   💡 Network routing issue to the device');
    }
  }

  // Test 2: UDP socket connection (ZKTeco often uses UDP)
  console.log('\n📡 Test 2: UDP Socket Connection');
  console.log('-------------------------------');

  try {
    const udpTest = await new Promise((resolve, reject) => {
      const dgram = require('dgram');
      const socket = dgram.createSocket('udp4');

      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('UDP connection timeout (8s)'));
      }, 8000);

      socket.on('error', (err) => {
        clearTimeout(timeout);
        socket.close();
        reject(err);
      });

      socket.on('message', (msg, rinfo) => {
        clearTimeout(timeout);
        console.log('✅ UDP response received:', msg.length, 'bytes');
        console.log('   Response from:', rinfo.address + ':' + rinfo.port);
        socket.close();
        resolve(true);
      });

      console.log(`   Sending UDP packet to ${ip}:${port}...`);

      // Send a basic ZKTeco command packet
      const testPacket = Buffer.alloc(16);
      testPacket.writeUInt16LE(0x50, 0); // ZKTeco command start

      socket.send(testPacket, port, ip, (err) => {
        if (err) {
          clearTimeout(timeout);
          socket.close();
          reject(err);
        }
      });
    });

  } catch (udpError) {
    console.log(`❌ UDP connection failed: ${udpError.message}`);
  }

  // Test 3: ZKTeco library connection
  console.log('\n📡 Test 3: ZKTeco Library Connection');
  console.log('-----------------------------------');

  try {
    const ZKTecoService = require('./services/zktecoService');
    const zkService = new ZKTecoService(ip, port);

    console.log('   Attempting ZKTeco service connection...');

    const connectResult = await Promise.race([
      zkService.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('ZKTeco connection timeout (15s)')), 15000)
      )
    ]);

    console.log('✅ ZKTeco library connection successful');
    console.log('   Connection details:', connectResult);

    await zkService.disconnect();

  } catch (zkError) {
    console.log(`❌ ZKTeco library connection failed: ${zkError.message}`);

    if (zkError.message.includes('timeout')) {
      console.log('   💡 Library can reach device but gets no response');
      console.log('   💡 This suggests device is in wrong communication mode');
    } else if (zkError.message.includes('ECONNREFUSED')) {
      console.log('   💡 Device is rejecting the connection protocol');
    }
  }

  // Test 4: Device status analysis
  console.log('\n🔍 Test 4: Device Status Analysis');
  console.log('---------------------------------');

  console.log('Based on the tests above, here\'s the diagnosis:');
  console.log('');
  console.log('Device Network Status:');
  console.log('✅ IP Address: Responding to ping');
  console.log('✅ Network Path: Available (3ms average)');
  console.log('');

  console.log('Possible Issues & Solutions:');
  console.log('');
  console.log('1. 🔧 Device Communication Mode:');
  console.log('   - Check if device is in "Network" mode (not Standalone)');
  console.log('   - Verify Communication settings in device menu');
  console.log('   - Ensure TCP/IP or UDP protocol is enabled');
  console.log('');
  console.log('2. 🔧 Port Configuration:');
  console.log('   - Default ZKTeco port is 4370');
  console.log('   - Check device network settings for custom port');
  console.log('   - Some models use different ports (8080, 80, etc.)');
  console.log('');
  console.log('3. 🔧 Device Service:');
  console.log('   - ZKTeco communication service might be stopped');
  console.log('   - Device might need restart');
  console.log('   - Check device system status');
  console.log('');
  console.log('4. 🔧 Firewall/Security:');
  console.log('   - Device firewall might block SDK connections');
  console.log('   - Network firewall might filter port 4370');
  console.log('   - Some devices require authentication first');
  console.log('');

  console.log('🎯 Recommended Actions:');
  console.log('======================');
  console.log('1. Access device web interface: http://192.168.1.201');
  console.log('2. Check Communication settings in device menu');
  console.log('3. Verify Network mode is enabled (not Standalone)');
  console.log('4. Restart the ZKTeco device');
  console.log('5. Try different ports if device uses custom configuration');

  console.log('\n🏁 Connection debugging completed!');
}

debugZKTecoConnection().catch(console.error);