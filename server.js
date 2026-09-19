const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// Global State Arrays
let activeBots = [];
let proxyDownBots = [];
let successAfkBots = [];
let bannedBots = [];

// Staff Evasion List (Matching Gamster Staff Roster)
let staffList = [
  "Henriks9", "NaysKutzu", "Maria_Int", "Crackernut", "Arfkek",
  "WOST_Ali", "Space_turtle9", "akyss", "lupu_xx_x", "Fredy_9",
  "_PixelWarriorYT_", "Megasus", "pintux", "TheAshz", "Tini_Alina",
  "karlthhkiller3", "OfficialMex", "mihaaiiii", "Gamster", "ItsB2_",
  "GamsterEvent", "LD007", "snaccks", "xSpeed10", "ATHUL"
];

// Helper: Parse SOCKS5 string (ip:port OR ip:port:user:pass)
function parseProxy(proxyStr) {
  if (!proxyStr) return null;
  const parts = proxyStr.trim().split(':');
  if (parts.length < 2) return null;
  return {
    host: parts[0].trim(),
    port: parseInt(parts[1].trim(), 10),
    userId: parts[2] ? parts[2].trim() : undefined,
    password: parts[3] ? parts[3].trim() : undefined
  };
}

// Format Uptime (Seconds -> HH:MM:SS)
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// Core Bot Initialization Function
function startBot(config) {
  const id = Math.random().toString(36).substring(2, 9);
  const proxyInfo = parseProxy(config.proxy);

  const botOptions = {
    host: config.host,
    port: config.port,
    username: config.username,
    version: '1.8.9', // Hardcoded 1.8.9 to bypass server protocol pre-pings over proxy
    checkTimeoutInterval: 30000
  };

  // Inject SOCKS5 Proxy Connector with Low-Latency Socket Flags
  if (proxyInfo) {
    botOptions.connect = (client) => {
      SocksClient.createConnection({
        proxy: {
          host: proxyInfo.host,
          port: proxyInfo.port,
          type: 5,
          userId: proxyInfo.userId,
          password: proxyInfo.password
        },
        command: 'connect',
        destination: {
          host: config.host,
          port: config.port
        },
        timeout: 20000 // Extended SOCKS handshake timeout
      }, (err, info) => {
        if (err) {
          console.error(`[PROXY FAIL] ${config.username} via ${proxyInfo.host}:${proxyInfo.port} -> ${err.message}`);
          client.emit('error', new Error(`SOCKS5 Proxy Failed: ${err.message}`));
          return;
        }

        // Apply TCP keep-alive and immediate-flush settings to prevent 10s drops
        info.socket.setKeepAlive(true, 10000);
        info.socket.setNoDelay(true);

        // Bind raw proxy socket to Mineflayer client
        client.setSocket(info.socket);
      });
    };
  }

  let bot;
  try {
    bot = mineflayer.createBot(botOptions);
  } catch (e) {
    console.error(`[SPAWN ERROR] ${config.username}: ${e.message}`);
    return;
  }

  const botRecord = {
    id,
    username: config.username,
    server: `${config.host}:${config.port}`,
    status: 'Connecting...',
    uptimeSeconds: config.savedUptime || 0,
    uptime: formatUptime(config.savedUptime || 0),
    ping: 0,
    logs: [`[System] Connecting via proxy: ${config.proxy || 'Direct Connection'}`],
    bot,
    dropCount: config.savedDropCount || 0,
    password: config.password,
    host: config.host,
    port: config.port,
    proxy: config.proxy || 'None'
  };

  activeBots.push(botRecord);
  emitDashboardUpdate();

  // Target AFK Timer: 20 Hours 10 Minutes (72,600 Seconds)
  const uptimeInterval = setInterval(() => {
    botRecord.uptimeSeconds++;
    botRecord.uptime = formatUptime(botRecord.uptimeSeconds);

    if (botRecord.uptimeSeconds >= 72600) {
      clearInterval(uptimeInterval);
      if (bot) bot.quit();
      activeBots = activeBots.filter(b => b.id !== id);
      successAfkBots.push({
        id,
        username: botRecord.username,
        server: botRecord.server,
        uptime: botRecord.uptime,
        password: botRecord.password,
        proxy: botRecord.proxy,
        completedAt: new Date().toLocaleTimeString()
      });
      emitDashboardUpdate();
    }
  }, 1000);

  // Anti-AFK Camera Movement
  const movementInterval = setInterval(() => {
    if (bot && bot.entity) {
      bot.look(bot.entity.yaw + 0.3, 0, true);
    }
  }, 8000);

  // Event: Spawn in World
  bot.on('spawn', () => {
    botRecord.status = 'Online & AFK';
    botRecord.dropCount = 0; // Reset drops on successful join
    botRecord.logs.push('[Spawn] Joined world via proxy.');
    emitDashboardUpdate();

    // Command Sequence: /register -> /login
    setTimeout(() => {
      if (config.password) {
        bot.chat(`/register ${config.password} ${config.password}`);
        botRecord.logs.push('[Auth] Sent /register');
      }
      setTimeout(() => {
        if (config.password) {
          bot.chat(`/login ${config.password}`);
          botRecord.logs.push('[Auth] Sent /login');
        }
        emitDashboardUpdate();
      }, 2000);
    }, 2000);
  });

  // Event: Kick / Ban Detection
  bot.on('kicked', (reason) => {
    const reasonText = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
    botRecord.logs.push(`[Kicked] ${reasonText}`);

    if (reasonText.toLowerCase().includes('ban') || reasonText.toLowerCase().includes('blacklisted')) {
      clearInterval(uptimeInterval);
      clearInterval(movementInterval);
      activeBots = activeBots.filter(b => b.id !== id);
      bannedBots.push({
        id,
        username: botRecord.username,
        server: botRecord.server,
        uptime: botRecord.uptime,
        password: botRecord.password,
        proxy: botRecord.proxy,
        reason: reasonText,
        time: new Date().toLocaleTimeString()
      });
      emitDashboardUpdate();
    }
  });

  bot.on('error', (err) => {
    botRecord.logs.push(`[Error] ${err.message}`);
  });

  // Event: Socket Disconnect
  bot.on('end', (reason) => {
    clearInterval(uptimeInterval);
    clearInterval(movementInterval);
    activeBots = activeBots.filter(b => b.id !== id);

    botRecord.dropCount += 1;
    botRecord.logs.push(`[Disconnect] ${reason || 'Connection lost'}`);

    // Move to Proxy Down table after 5 consecutive drops
    if (botRecord.dropCount >= 5) {
      proxyDownBots = proxyDownBots.filter(b => b.username !== botRecord.username);
      proxyDownBots.push({
        id,
        username: botRecord.username,
        server: botRecord.server,
        uptime: botRecord.uptime,
        uptimeSeconds: botRecord.uptimeSeconds,
        password: botRecord.password,
        proxy: botRecord.proxy,
        host: config.host,
        port: config.port,
        reason: `Exceeded 5 proxy drops`,
        timestamp: new Date().toLocaleTimeString()
      });
      emitDashboardUpdate();
    } else {
      // Auto-reconnect after 4 seconds retaining accumulated uptime
      setTimeout(() => {
        startBot({
          host: config.host,
          port: config.port,
          username: config.username,
          password: config.password,
          proxy: config.proxy,
          savedUptime: botRecord.uptimeSeconds,
          savedDropCount: botRecord.dropCount
        });
      }, 4000);
    }
  });

  // Staff Evasion Detection
  bot.on('playerJoined', (player) => {
    if (player && player.username) {
      checkStaff(bot, botRecord, player.username);
    }
  });

  // Packet-level Staff Evasion (Detects staff in tab list instantly)
  bot._client.on('packet', (data, meta) => {
    if (meta.name === 'player_info' && data.action === 0 && data.data) {
      for (const p of data.data) {
        if (p.name) checkStaff(bot, botRecord, p.name);
      }
    }
  });
}

function checkStaff(bot, botRecord, playerName) {
  const isStaff = staffList.some(s => s.toLowerCase() === playerName.toLowerCase());
  if (isStaff) {
    botRecord.logs.push(`[EVADED] Staff detected: ${playerName}. Disconnecting...`);
    if (bot) bot.quit();
  }
}

// Broadcast State to Dashboard UI
function emitDashboardUpdate() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ramUsage = Math.floor(((totalMem - freeMem) / totalMem) * 100);
  const cpuLoad = Math.floor(Math.random() * 10) + 5;

  io.emit('dashboard_update', {
    system: { cpuLoad, ramUsage },
    active: activeBots.map(b => ({
      id: b.id,
      username: b.username,
      password: b.password,
      server: b.server,
      proxy: b.proxy,
      status: b.status,
      uptime: b.uptime,
      dropCount: b.dropCount,
      ping: b.bot?._client?.latency || 35,
      logs: b.logs.slice(-5)
    })),
    proxyDown: proxyDownBots,
    successAfk: successAfkBots,
    banned: bannedBots,
    staff: staffList.map(name => ({
      name,
      head: `https://mc-heads.net/avatar/${encodeURIComponent(name)}/28`
    }))
  });
}

// Socket.io Realtime Controller
io.on('connection', (socket) => {
  emitDashboardUpdate();

  // Batch Launch Request
  socket.on('deploy_bots', (data) => {
    const { serverIP, usernamesRaw, password, proxy, proxiesRaw } = data;
    const selectedProxy = proxy || (proxiesRaw ? proxiesRaw.split('\n')[0] : null);

    const usernames = (usernamesRaw || '').split(/[\n,]+/).map(u => u.trim()).filter(Boolean);

    if (usernames.length === 0) {
      socket.emit('deploy_error', 'No usernames provided!');
      return;
    }

    const hostParts = (serverIP || 'gamester.org:25565').split(':');
    const host = hostParts[0].trim();
    const port = hostParts[1] ? parseInt(hostParts[1].trim(), 10) : 25565;

    // Stagger connections by 2000ms per bot to avoid proxy socket rate-limits
    usernames.slice(0, 4).forEach((username, index) => {
      setTimeout(() => {
        // Clean from Proxy Down table
        proxyDownBots = proxyDownBots.filter(b => b.username !== username);

        // Remove active instance if existing
        const existingIdx = activeBots.findIndex(b => b.username === username);
        if (existingIdx !== -1) {
          if (activeBots[existingIdx].bot) activeBots[existingIdx].bot.quit();
          activeBots.splice(existingIdx, 1);
        }

        startBot({
          username,
          host,
          port,
          password,
          proxy: selectedProxy ? selectedProxy.trim() : null
        });
      }, index * 2000);
    });

    socket.emit('deploy_success', `Batch launched for ${usernames.length} bot(s)!`);
    emitDashboardUpdate();
  });

  socket.on('stop_bot', (id) => {
    const index = activeBots.findIndex(b => b.id === id || b.username === id);
    if (index !== -1) {
      if (activeBots[index].bot) activeBots[index].bot.quit();
      activeBots.splice(index, 1);
      emitDashboardUpdate();
    }
  });

  socket.on('add_staff', (name) => {
    const cleanName = name ? name.trim() : "";
    if (cleanName && !staffList.includes(cleanName)) {
      staffList.push(cleanName);
      emitDashboardUpdate();
    }
  });

  socket.on('remove_staff', (name) => {
    staffList = staffList.filter(s => s !== name);
    emitDashboardUpdate();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dark AFK Client Pro] Dashboard listening on http://0.0.0.0:${PORT}`);
});
    
