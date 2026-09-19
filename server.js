const express = require('express');
const path = require('path');
const fs = require('fs');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');

// Prevent unexpected crashes from killing the dashboard
process.on('uncaughtException', (err) => console.error('CRITICAL EXCEPTION:', err));
process.on('unhandledRejection', (reason) => console.error('CRITICAL REJECTION:', reason));

const app = express();
const PORT = process.env.PORT || 3000;
const BOTS_FILE = './bots_db.json';

// Known staff list for the Evasion Radar
const STAFF_LIST = ['Henriks9', 'Admin', 'Moderator']; 

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const activeBots = new Map();

function loadBotsDb() {
  try {
    if (fs.existsSync(BOTS_FILE)) return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
  } catch (err) {}
  return {};
}

function saveBotsDb(data) {
  try { fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2)); } catch (err) {}
}

function parseProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  const parts = proxyStr.trim().split(':');
  if (parts.length >= 4) return { host: parts[0], port: parseInt(parts[1], 10), userId: parts[2], password: parts.slice(3).join(':') };
  if (parts.length === 2) return { host: parts[0], port: parseInt(parts[1], 10) };
  return null;
}

function createSocksConnect(proxyConfig, targetHost, targetPort) {
  return (clientInstance) => {
    const options = {
      proxy: { host: proxyConfig.host, port: proxyConfig.port, type: 5 },
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      timeout: 10000
    };
    if (proxyConfig.userId && proxyConfig.password) {
      options.proxy.userId = proxyConfig.userId;
      options.proxy.password = proxyConfig.password;
    }
    SocksClient.createConnection(options)
      .then((info) => {
        clientInstance.setSocket(info.socket);
        clientInstance.emit('connect');
      })
      .catch((err) => {
        clientInstance.emit('error', new Error(`Proxy Connection Failed: ${err.message}`));
      });
  };
}

function formatUptime(ms) {
  const s = Math.floor((ms / 1000) % 60);
  const m = Math.floor((ms / (1000 * 60)) % 60);
  const h = Math.floor(ms / (1000 * 60 * 60));
  return `${h}h ${m}m ${s}s`;
}

function startBotInstance(options) {
  const { username, password, authType, proxyInput, mcVersion, host, port, hffaEnabled, radarEnabled } = options;
  const proxyConfig = parseProxy(proxyInput);

  const botOpts = {
    host,
    port,
    username,
    auth: authType || 'offline', 
    version: mcVersion || '1.8.9',
    hideErrors: true
  };

  // Only pass password if using offline auth (for /login commands later)
  if (authType === 'microsoft' && password) {
    botOpts.password = password; 
  }

  if (proxyConfig) {
    botOpts.connect = createSocksConnect(proxyConfig, host, port);
  }

  let bot;
  try {
    bot = mineflayer.createBot(botOpts);
  } catch (err) {
    console.error(`[${username}] Boot error:`, err.message);
    scheduleReconnect(options, 30000); // Wait 30s before retrying dead proxy
    return;
  }

  let instanceData = activeBots.get(username) || {
    bot: null, startTime: Date.now(),
    afkInterval: null, hffaInterval: null, reconnectTimer: null,
    chatLogs: [], proxyStatus: proxyConfig ? 'Connecting...' : 'Direct',
    options
  };

  instanceData.bot = bot;
  activeBots.set(username, instanceData);

  const allBots = loadBotsDb();
  allBots[username] = options;
  saveBotsDb(allBots);

  bot.on('messagestr', (message) => {
    if (message && message.trim().length > 0) {
      instanceData.chatLogs.push(message);
      if (instanceData.chatLogs.length > 30) instanceData.chatLogs.shift();
    }
  });

  bot.once('spawn', () => {
    instanceData.proxyStatus = proxyConfig ? 'Healthy' : 'Direct';
    
    // Auto-login for cracked accounts
    if (authType === 'offline' && password) {
      setTimeout(() => bot.chat(`/register ${password} ${password}`), 1000);
      setTimeout(() => bot.chat(`/login ${password}`), 2500);
    }

    // Anti-AFK Loop
    instanceData.afkInterval = setInterval(() => {
      try {
        bot.swingArm('right');
        bot.look(bot.entity.yaw + (Math.random() - 0.5) * 0.5, bot.entity.pitch, false);
      } catch (e) {}
    }, 45000);

    // HardcoreFFA Auto-Join
    if (hffaEnabled) {
      instanceData.hffaInterval = setInterval(() => {
        bot.chat('/play hardcoreffa');
      }, 70000);
    }
  });

  // --- ANTI-STAFF EVASION RADAR ---
  if (radarEnabled) {
    bot.on('playerJoined', (player) => {
      if (STAFF_LIST.some(staff => player.username.toLowerCase() === staff.toLowerCase())) {
        const alertMsg = `⚠️ RADAR ALERT: Staff ${player.username} detected! Evading immediately.`;
        instanceData.chatLogs.push(alertMsg);
        console.log(`[${username}] ${alertMsg}`);
        bot.quit();
        scheduleReconnect(options, 600000); // Wait 10 minutes before returning if staff was seen
      }
    });
  }

  const handleDisconnect = (err) => {
    if (instanceData.afkInterval) clearInterval(instanceData.afkInterval);
    if (instanceData.hffaInterval) clearInterval(instanceData.hffaInterval);
    
    if (err && err.message) {
      instanceData.proxyStatus = `Error: ${err.message.substring(0, 20)}`;
    } else {
      instanceData.proxyStatus = 'Offline / Reconnecting';
    }
    
    // Default 25s reconnect unless staff evasion overrode it
    if (!instanceData.reconnectTimer) scheduleReconnect(options, 25000); 
  };

  bot.on('kicked', handleDisconnect);
  bot.on('error', handleDisconnect);
  bot.on('end', handleDisconnect);
}

function scheduleReconnect(options, delay) {
  const { username } = options;
  let instanceData = activeBots.get(username);
  if (instanceData) {
    if (instanceData.reconnectTimer) clearTimeout(instanceData.reconnectTimer);
    instanceData.reconnectTimer = setTimeout(() => {
      instanceData.reconnectTimer = null;
      if (activeBots.has(username)) startBotInstance(options);
    }, delay);
  }
}

app.post('/api/spawn', (req, res) => {
  const { server, username, password, authType, proxy, version, hffaEnabled, radarEnabled } = req.body;
  if (!server || !username) return res.status(400).json({ error: 'Server and username required' });
  if (activeBots.has(username)) return res.status(400).json({ error: 'Bot is already active' });

  const [host, portRaw] = server.split(':');
  
  startBotInstance({
    username, password: password || '', authType: authType || 'offline',
    proxyInput: proxy || '', mcVersion: version || '1.8.9',
    host, port: parseInt(portRaw, 10) || 25565,
    hffaEnabled: !!hffaEnabled, radarEnabled: !!radarEnabled
  });
  
  res.json({ success: true });
});

app.post('/api/disconnect', (req, res) => {
  const { username } = req.body;
  if (username === 'all') {
    activeBots.forEach((data) => {
      if (data.reconnectTimer) clearTimeout(data.reconnectTimer);
      if (data.afkInterval) clearInterval(data.afkInterval);
      if (data.bot) try { data.bot.quit(); } catch(e){}
    });
    activeBots.clear();
    saveBotsDb({});
    return res.json({ success: true });
  }

  const data = activeBots.get(username);
  if (data) {
    if (data.reconnectTimer) clearTimeout(data.reconnectTimer);
    if (data.afkInterval) clearInterval(data.afkInterval);
    if (data.bot) try { data.bot.quit(); } catch(e){}
    activeBots.delete(username);
    const allBots = loadBotsDb();
    delete allBots[username];
    saveBotsDb(allBots);
  }
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  const statuses = [];
  activeBots.forEach((data, username) => {
    statuses.push({
      username,
      auth: data.options.authType,
      host: `${data.options.host}:${data.options.port}`,
      uptime: formatUptime(Date.now() - data.startTime),
      proxyStatus: data.proxyStatus,
      radar: !!data.options.radarEnabled,
      chatLogs: data.chatLogs.slice(-10)
    });
  });
  res.json(statuses);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sleepy Client Master Server listening on port ${PORT}`);
  const savedBots = loadBotsDb();
  for (const config of Object.values(savedBots)) {
    startBotInstance(config);
  }
});
