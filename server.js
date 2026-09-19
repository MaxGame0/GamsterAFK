const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const os = require('os');

// Crash Prevention Guards
process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH GUARD] Unhandled Rejection:', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Global State (Dark AFK Pattern)
let activeBots = [];
let proxyDownBots = [];
let successAfkBots = [];
let bannedBots = [];

// Staff Evasion List
let staffList = [
  "Henriks9", "NaysKutzu", "Maria_Int", "Crackernut", "Arfkek",
  "WOST_Ali", "Space_turtle9", "akyss", "lupu_xx_x", "Fredy_9",
  "_PixelWarriorYT_", "Megasus", "pintux", "TheAshz", "Tini_Alina",
  "karlthhkiller3", "OfficialMex", "mihaaiiii", "Gamster", "ItsB2_",
  "GamsterEvent", "LD007", "snaccks", "xSpeed10", "ATHUL"
];

// Helper: Parse SOCKS5 string (ip:port or ip:port:user:pass)
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

// -------------------- CORE BOT CREATION --------------------
function startBot(config) {
  const id = Math.random().toString(36).substring(2, 9);
  const proxyInfo = parseProxy(config.proxy);

  const botOptions = {
    host: config.host,
    port: config.port,
    username: config.username,
    version: '1.8.9', // Hardcoded 1.8.9 to avoid pre-ping socket drop
    checkTimeoutInterval: 30000
  };

  // Inject SOCKS5 Proxy handler if proxy provided
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
        timeout: 15000
      }, (err, info) => {
        if (err) {
          console.error(`[PROXY FAIL] ${config.username}: ${err.message}`);
          client.emit('error', new Error(`SOCKS5 Error: ${err.message}`));
          return;
        }

        // Configure raw TCP socket for Minecraft traffic
        info.socket.setKeepAlive(true, 10000);
        info.socket.setNoDelay(true);

        // Bind socket to Mineflayer (setSocket automatically connects)
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
    logs: [`[System] Connecting via proxy: ${config.proxy || 'Direct'}`],
    bot,
    dropCount: config.savedDropCount || 0,
    password: config.password,
    host: config.host,
    port: config.port,
    proxy: config.proxy || 'None'
  };

  activeBots.push(botRecord);
  emitDashboardUpdate();

  // 20 Hours 10 Minutes Target (72,600 Seconds)
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

  // Anti-AFK Look Loop
  const movementInterval = setInterval(() => {
    if (bot && bot.entity) {
      bot.look(bot.entity.yaw + 0.3, 0, true);
    }
  }, 8000);

  // Bot Joined World
  bot.on('spawn', () => {
    botRecord.status = 'Online & AFK';
    botRecord.dropCount = 0; // Reset consecutive drop count on successful login
    botRecord.logs.push('[Spawn] Connected to server.');
    emitDashboardUpdate();

    // Auto /register -> /login sequence
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

  // Handle Kick / Ban / Disconnect
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

  bot.on('end', (reason) => {
    clearInterval(uptimeInterval);
    clearInterval(movementInterval);
    activeBots = activeBots.filter(b => b.id !== id);

    botRecord.dropCount += 1;
    botRecord.logs.push(`[Disconnect] ${reason || 'Socket closed'}`);

    // If bot drops 5 times, move to Proxy Down table
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
      // Auto-reconnect after 4 seconds using saved uptime
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

  // Staff Evasion: Check Tablist/Joined Players
  bot.on('playerJoined', (player) => {
    if (player && player.username) {
      checkStaff(bot, botRecord, player.username);
    }
  });

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
    botRecord.logs.push(`[STAFF EVADE] Staff ${playerName} detected! Disconnecting...`);
    if (bot) bot.quit();
  }
}

// -------------------- SOCKET.IO EVENTS --------------------
io.on('connection', (socket) => {
  emitDashboardUpdate();

  // Unified Deploy / Launch Batch (Server IP, 1 Password, Up to 4 Users, 1 Proxy)
  socket.on('deploy_bots', (data) => {
    const { serverIP, usernamesRaw, password, proxy } = data;
    const usernames = usernamesRaw.split(/[\n,]+/).map(u => u.trim()).filter(Boolean);

    if (usernames.length === 0) {
      socket.emit('deploy_error', 'No usernames provided!');
      return;
    }

    const hostParts = (serverIP || 'gamester.org:25565').split(':');
    const host = hostParts[0].trim();
    const port = hostParts[1] ? parseInt(hostParts[1].trim(), 10) : 25565;

    // Stagger bot logins by 2 seconds to prevent SOCKS proxy concurrency blocks
    usernames.slice(0, 4).forEach((username, index) => {
      setTimeout(() => {
        // Clear from Proxy Down table if reviving
        proxyDownBots = proxyDownBots.filter(b => b.username !== username);

        // Remove existing active bot instance if present
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
          proxy: proxy ? proxy.trim() : null
        });
      }, index * 2000);
    });

    socket.emit('deploy_success', `Batch launched for ${usernames.length} bot(s)!`);
    emitDashboardUpdate();
  });

  socket.on('stop_bot', (id) => {
    const index = activeBots.findIndex(b => b.id === id);
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

// -------------------- UTILITY FUNCTIONS --------------------
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

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
    staff: staffList
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dark AFK Client Pro] Dashboard running on http://0.0.0.0:${PORT}`);
});
  
