const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- STORAGE & CONFIG ---
const activeBots = new Map();       // Running bots
const proxyDownBots = new Map();    // Bots stopped because proxy went down
const bannedBots = [];              // Banned bots log
const globalProxyPool = [];         // Global proxy storage

const staffList = [
  'henriks9', 'maria_int', 'nayskutzu', 'fredy_9', 'crackernut',
  'synchitss', 'gamsterevent', 'ionutz547', 'ld007', 'bombita_01',
  'osmiumredox', 'gr_veteran', 'snackks', 'andreibeni', 'urswu',
  'lupu_xx_x', 'x5speed10', 'doritostar', 'deepinangels', 'godkissed',
  'athul', '_pixelwarrioryt_', 'henzh'
];

// --- UNIVERSAL PROXY PARSER ---
function parseAnyProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  proxyStr = proxyStr.trim();
  let host, port, userId, password, type = 5;

  if (proxyStr.includes('@')) {
    const parts = proxyStr.split('@');
    if (parts.length === 2) {
      const left = parts[0];
      const right = parts[1];
      if (right.includes(':')) {
        userId = left.split(':')[0];
        password = left.split(':').slice(1).join(':');
        const hp = right.split(':');
        host = hp[0];
        port = parseInt(hp[1], 10);
      } else if (left.includes(':')) {
        const hp = left.split(':');
        host = hp[0];
        port = parseInt(hp[1], 10);
        userId = right.split(':')[0];
        password = right.split(':').slice(1).join(':');
      }
    }
  } else {
    const parts = proxyStr.split(':');
    if (parts.length === 2) {
      host = parts[0];
      port = parseInt(parts[1], 10);
    } else if (parts.length >= 4) {
      host = parts[0];
      port = parseInt(parts[1], 10);
      userId = parts[2];
      password = parts.slice(3).join(':');
    }
  }
  if (!host || isNaN(port)) return null;
  return { host, port, userId, password, type };
}

// --- PROXY CHECKER ---
function testProxyConnection(proxyStr) {
  return new Promise((resolve) => {
    const config = parseAnyProxy(proxyStr);
    if (!config) return resolve({ success: false });

    const options = {
      proxy: { host: config.host, port: config.port, type: config.type },
      command: 'connect',
      destination: { host: 'api.ipify.org', port: 80 },
      timeout: 8000
    };
    if (config.userId && config.password) {
      options.proxy.userId = config.userId;
      options.proxy.password = config.password;
    }

    SocksClient.createConnection(options, (err, info) => {
      if (err) return resolve({ success: false });
      const socket = info.socket;
      let data = '';
      socket.setTimeout(6000);
      socket.on('data', chunk => data += chunk.toString());
      socket.on('end', () => resolve({ success: data.length > 0 }));
      socket.on('error', () => resolve({ success: false }));
      socket.on('timeout', () => { socket.destroy(); resolve({ success: false }); });
      socket.write('GET /?format=text HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
    });
  });
}

function createSocksConnect(proxyConfig, targetHost, targetPort) {
  return function(clientInstance) {
    const options = {
      proxy: { host: proxyConfig.host, port: proxyConfig.port, type: proxyConfig.type },
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      timeout: 15000
    };
    if (proxyConfig.userId && proxyConfig.password) {
      options.proxy.userId = proxyConfig.userId;
      options.proxy.password = proxyConfig.password;
    }
    SocksClient.createConnection(options)
      .then(info => { clientInstance.setSocket(info.socket); clientInstance.emit('connect'); })
      .catch(err => { try { clientInstance.emit('error', new Error('SOCKS Error: ' + err.message)); } catch(e){} });
  };
}

// --- BOT INSTANCE ENGINE ---
function startBotInstance(config) {
  const { id, username, password, host, port, proxyInput } = config;
  const proxyConfig = parseAnyProxy(proxyInput);

  let botData = activeBots.get(id);
  if (!botData) {
    botData = {
      bot: null,
      logs: [],
      status: 'Connecting...',
      config: config,
      reconnectTimer: null,
      movementInterval: null,
      hourlyTimer: null,
      accumulatedUptime: 0,
      connectedAt: null,
      consecutiveDrops: 0
    };
    activeBots.set(id, botData);
  } else {
    // Clear old timers if restarting instance
    if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
    if (botData.movementInterval) clearInterval(botData.movementInterval);
    if (botData.hourlyTimer) clearTimeout(botData.hourlyTimer);
    botData.config = config;
  }

  const botOpts = { host, port, username, version: '1.8.9', viewDistance: 2 };
  if (proxyConfig) botOpts.connect = createSocksConnect(proxyConfig, host, port);

  let bot;
  try {
    bot = mineflayer.createBot(botOpts);
  } catch (err) {
    botData.status = 'Initialization Failed';
    return;
  }

  botData.bot = bot;
  botData.status = 'Connecting...';

  function logMsg(msg) {
    botData.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (botData.logs.length > 40) botData.logs.shift();
  }

  let lastKick = '';
  bot.on('kicked', reason => {
    try { lastKick = typeof reason === 'string' ? reason : JSON.stringify(reason); }
    catch(e) { lastKick = String(reason); }
    logMsg(`Kicked: ${lastKick}`);
  });

  function handleStaffEvasion(staffName) {
    logMsg(`🚨 Staff ${staffName} detected! Disconnecting & reconnecting in 15s.`);
    botData.status = `Staff Evasion (${staffName}) - Reconnecting in 15s`;
    if (botData.reconnectTimer) clearTimeout(botData.reconnectTimer);
    if (botData.movementInterval) clearInterval(botData.movementInterval);
    if (botData.hourlyTimer) clearTimeout(botData.hourlyTimer);
    try { bot.quit(); } catch(e){}
    botData.reconnectTimer = setTimeout(() => {
      if (activeBots.has(id)) startBotInstance(config);
    }, 15000);
  }

  bot.once('spawn', () => {
    logMsg(`Spawned successfully on ${host}:${port}`);

    // Check staff already online
    if (bot.players) {
      for (const p of Object.values(bot.players)) {
        if (p && p.username && staffList.includes(p.username.toLowerCase())) {
          handleStaffEvasion(p.username);
          return;
        }
      }
    }

    // Login / Register authentication flow
    if (password) {
      setTimeout(() => { try { bot.chat(`/register ${password} ${password}`); } catch(e){} }, 2000);
      setTimeout(() => {
        try {
          bot.chat(`/login ${password}`);
          botData.status = 'Connected & AFK Active';
          botData.consecutiveDrops = 0;
          botData.connectedAt = Date.now();
          startLobbyMovement(botData);
          startHourlyRefreshTimer(botData, id, config);
        } catch(e){}
      }, 4500);
    } else {
      botData.status = 'Connected & AFK Active';
      botData.consecutiveDrops = 0;
      botData.connectedAt = Date.now();
      startLobbyMovement(botData);
      startHourlyRefreshTimer(botData, id, config);
    }
  });

  bot.on('playerJoined', p => {
    if (p && p.username && staffList.includes(p.username.toLowerCase())) {
      handleStaffEvasion(p.username);
    }
  });

  bot.on('chat', (uname) => {
    if (uname && staffList.includes(uname.toLowerCase())) {
      handleStaffEvasion(uname);
    }
  });

  bot.on('end', async () => {
    if (botData.status.includes('Staff') || botData.status.includes('Hourly Refresh')) return;

    // Pause uptime calculation on disconnect
    if (botData.connectedAt) {
      botData.accumulatedUptime += Date.now() - botData.connectedAt;
      botData.connectedAt = null;
    }
    if (botData.movementInterval) clearInterval(botData.movementInterval);
    if (botData.hourlyTimer) clearTimeout(botData.hourlyTimer);

    botData.consecutiveDrops++;
    logMsg(`Disconnected (Drop #${botData.consecutiveDrops})`);

    // Check if banned
    if (lastKick.toLowerCase().includes('ban')) {
      logMsg(`🚫 Bot Banned: ${lastKick}`);
      bannedBots.push({ username, reason: lastKick, time: new Date().toLocaleString() });
      activeBots.delete(id);
      return;
    }

    // Only check proxy after 25 consecutive drops
    if (botData.consecutiveDrops >= 25) {
      logMsg(`Reached 25 drops. Verifying proxy health...`);
      let proxyAlive = false;
      for (let i = 0; i < 3; i++) {
        const res = await testProxyConnection(proxyInput);
        if (res.success) { proxyAlive = true; break; }
        await new Promise(r => setTimeout(r, 2000));
      }

      if (proxyAlive) {
        logMsg(`Proxy is alive! Resetting drop counter and continuing.`);
        botData.consecutiveDrops = 0;
        botData.reconnectTimer = setTimeout(() => { if (activeBots.has(id)) startBotInstance(config); }, 15000);
        return;
      } else {
        logMsg(`❌ Proxy DEAD after 25 drops. Moving bot to Proxy-Down section.`);
        let currentSession = botData.connectedAt ? (Date.now() - botData.connectedAt) : 0;
        let totalMs = botData.accumulatedUptime + currentSession;
        
        proxyDownBots.set(id, {
          ...config,
          totalUptimeMs: totalMs,
          failedAt: new Date().toLocaleString()
        });
        activeBots.delete(id);
        return;
      }
    }

    // Standard reconnect before 25 drops (no proxy check yet)
    botData.status = `Disconnected (Reconnecting in 15s - Drop #${botData.consecutiveDrops})`;
    botData.reconnectTimer = setTimeout(() => {
      if (activeBots.has(id)) startBotInstance(config);
    }, 15000);
  });
}

// --- HOURLY REFRESH TIMER ---
function startHourlyRefreshTimer(botData, id, config) {
  if (botData.hourlyTimer) clearTimeout(botData.hourlyTimer);

  // 1 Hour = 3600000 milliseconds
  botData.hourlyTimer = setTimeout(() => {
    botData.status = `Hourly Refresh - Reconnecting`;
    botData.logs.push(`[${new Date().toLocaleTimeString()}] ⏰ Reached 1 hour limit. Performing scheduled disconnect & rejoin.`);
    
    if (botData.movementInterval) clearInterval(botData.movementInterval);
    if (botData.connectedAt) {
      botData.accumulatedUptime += Date.now() - botData.connectedAt;
      botData.connectedAt = null;
    }

    try { botData.bot.quit(); } catch(e){}

    // Rejoin after 5 seconds pause
    botData.reconnectTimer = setTimeout(() => {
      if (activeBots.has(id)) {
        startBotInstance(config);
      }
    }, 5000);
  }, 3600000);
}

// --- LOBBY MOVEMENT LOOP ---
function startLobbyMovement(botData) {
  if (botData.movementInterval) clearInterval(botData.movementInterval);

  const runMovementCycle = () => {
    if (!botData.bot || !botData.bot.entity) return;
    const walkDuration = Math.floor(Math.random() * 30000) + 30000; // 30s to 1 min
    const restDuration = (Math.floor(Math.random() * 6) + 5) * 60 * 1000; // 5-10 minutes rest

    const directions = ['forward', 'back', 'left', 'right'];
    const chosenDir = directions[Math.floor(Math.random() * directions.length)];
    
    try {
      botData.bot.setControlState(chosenDir, true);
      setTimeout(() => {
        try { botData.bot.clearControlStates(); } catch(e){}
      }, walkDuration);
    } catch(e){}

    botData.movementInterval = setTimeout(runMovementCycle, walkDuration + restDuration);
  };

  botData.movementInterval = setTimeout(runMovementCycle, 60000);
}

// --- SOCKET.IO REALTIME DASHBOARD API ---
io.on('connection', socket => {
  
  const interval = setInterval(() => {
    const activeList = [];
    activeBots.forEach((data, id) => {
      let currentSession = data.connectedAt ? (Date.now() - data.connectedAt) : 0;
      let totalUptime = data.accumulatedUptime + currentSession;
      let pos = data.bot && data.bot.entity ? data.bot.entity.position : {x:0, y:0, z:0};
      
      activeList.push({
        id,
        username: data.config.username,
        server: `${data.config.host}:${data.config.port}`,
        status: data.status,
        ping: data.bot && data.bot.player ? data.bot.player.ping : 'N/A',
        health: data.bot ? data.bot.health : 'N/A',
        drops: data.consecutiveDrops,
        uptime: formatUptime(totalUptime),
        pos: `X: ${Math.floor(pos.x)}, Y: ${Math.floor(pos.y)}, Z: ${Math.floor(pos.z)}`,
        logs: data.logs.slice(-5)
      });
    });

    const proxyDownList = [];
    proxyDownBots.forEach((data, id) => {
      proxyDownList.push({
        id,
        username: data.username,
        server: `${data.host}:${data.port}`,
        password: data.password,
        uptime: formatUptime(data.totalUptimeMs),
        failedAt: data.failedAt
      });
    });

    socket.emit('dashboard_update', {
      active: activeList,
      proxyDown: proxyDownList,
      banned: bannedBots,
      staffCount: staffList.length
    });
  }, 1000);

  socket.on('disconnect', () => clearInterval(interval));

  socket.on('deploy_bots', data => {
    const { serverIP, usernamesRaw, password, proxiesRaw } = data;
    const usernames = usernamesRaw.split(',').map(u => u.trim()).filter(Boolean);
    const proxies = proxiesRaw ? proxiesRaw.split(',').map(p => p.trim()).filter(Boolean) : [];

    if (proxies.length > 0 && usernames.length > proxies.length * 4) {
      return socket.emit('deploy_error', `❌ Proxy Limit Violation! 1 Proxy can support a maximum of 4 bots. You provided ${proxies.length} proxy(ies) for ${usernames.length} bots.`);
    }

    const [host, portRaw] = serverIP.split(':');
    const port = parseInt(portRaw, 10) || 25565;

    usernames.forEach((username, index) => {
      let proxyInput = '';
      if (proxies.length > 0) {
        proxyInput = proxies[Math.floor(index / 4)];
      }

      const id = `bot_${username}_${Date.now()}_${index}`;
      startBotInstance({ id, username, password, host, port, proxyInput });
    });

    socket.emit('deploy_success', `Successfully deployed ${usernames.length} bot(s)!`);
  });

  socket.on('recover_proxy_down', data => {
    const { botIds, newProxy } = data;
    if (botIds.length > 4) {
      return socket.emit('deploy_error', `❌ You can assign a new proxy to a maximum of 4 disconnected bots at a time!`);
    }

    botIds.forEach(id => {
      const botConfig = proxyDownBots.get(id);
      if (botConfig) {
        proxyDownBots.delete(id);
        startBotInstance({
          id: `bot_${botConfig.username}_${Date.now()}`,
          username: botConfig.username,
          password: botConfig.password,
          host: botConfig.host,
          port: botConfig.port,
          proxyInput: newProxy
        });
      }
    });

    socket.emit('deploy_success', `Successfully revived ${botIds.length} bot(s) with the new proxy!`);
  });

  socket.on('stop_bot', id => {
    if (activeBots.has(id)) {
      const b = activeBots.get(id);
      if (b.reconnectTimer) clearTimeout(b.reconnectTimer);
      if (b.movementInterval) clearInterval(b.movementInterval);
      if (b.hourlyTimer) clearTimeout(b.hourlyTimer);
      try { b.bot.quit(); } catch(e){}
      activeBots.delete(id);
    }
    if (proxyDownBots.has(id)) proxyDownBots.delete(id);
  });

  socket.on('add_staff', username => {
    const name = username.trim().toLowerCase();
    if (name && !staffList.includes(name)) {
      staffList.push(name);
      socket.emit('deploy_success', `Added ${name} to staff evasion list.`);
    }
  });
});

function formatUptime(ms) {
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / (1000 * 60)) % 60);
  const h = Math.floor(ms / (1000 * 60 * 60));
  return `${h}h ${m}m ${s}s`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Dark AFK Client] Running on port ${PORT}`));
  
