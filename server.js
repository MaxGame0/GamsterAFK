const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const net = require('net');
const axios = require('axios');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { SocksProxyAgent } = require('socks-proxy-agent');

process.on('uncaughtException', (err) => {
  console.error('CRITICAL UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('CRITICAL UNHANDLED REJECTION:', reason);
});

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const BOTS_FILE = './bots_db.json';
const PROXY_DOWN_FILE = './proxy_down_db.json';
const SUCCESS_AFK_FILE = './success_afk_db.json';
const STAFF_FILE = './staff_db.json';

const TARGET_AFK_MS = (20 * 60 + 1) * 60 * 1000; // 20 hours 1 minute in ms

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const activeBots = new Map();

// --- Database Helpers ---

function readDb(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Error reading ${filePath}:`, err);
  }
  return {};
}

function writeDb(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error writing ${filePath}:`, err);
  }
}

// --- Staff Evasion List Management ---

function getStaffList() {
  const defaultStaff = ['staff', 'admin', 'mod', 'helper', 'owner', 'henriks9'];
  try {
    if (fs.existsSync(STAFF_FILE)) {
      return JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8'));
    } else {
      fs.writeFileSync(STAFF_FILE, JSON.stringify(defaultStaff, null, 2));
      return defaultStaff;
    }
  } catch (err) {
    return defaultStaff;
  }
}

function saveStaffList(list) {
  try {
    fs.writeFileSync(STAFF_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error('Error saving staff list:', err);
  }
}

function checkIsStaff(username) {
  if (!username) return false;
  const lower = username.toLowerCase();
  const currentStaffList = getStaffList();
  return currentStaffList.some((kw) => lower.includes(kw.toLowerCase()));
}

// --- Proxy Helpers & TCP Check ---

function parseProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  const parts = proxyStr.trim().split(':');
  if (parts.length >= 4) {
    return {
      host: parts[0],
      port: parseInt(parts[1], 10),
      userId: parts[2],
      password: parts.slice(3).join(':')
    };
  } else if (parts.length === 2) {
    return { host: parts[0], port: parseInt(parts[1], 10) };
  }
  return null;
}

function checkProxyAlive(proxyConfig) {
  return new Promise((resolve) => {
    if (!proxyConfig) return resolve(true);
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(proxyConfig.port, proxyConfig.host);
  });
}

function createSocksConnect(proxyConfig, targetHost, targetPort) {
  return (clientInstance) => {
    const options = {
      proxy: { host: proxyConfig.host, port: proxyConfig.port, type: 5 },
      command: 'connect',
      destination: { host: targetHost, port: targetPort },
      timeout: 15000
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
        try {
          clientInstance.emit('error', new Error(`SOCKS5 Error: ${err.message}`));
        } catch (e) {
          console.error('Socks connection error:', e.message);
        }
      });
  };
}

function formatUptime(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  return `${hours}h ${minutes}m ${seconds}s`;
}

// --- Anti-AFK Movement Routine ---

function triggerAntiAfkMovement(bot) {
  if (!bot || !bot.entity) return;

  const controls = ['forward', 'backwards', 'left', 'right', 'jump', 'sprint'];
  const startTime = Date.now();

  const moveInterval = setInterval(() => {
    if (!bot || !bot.entity || Date.now() - startTime > 15000) {
      clearInterval(moveInterval);
      controls.forEach((ctrl) => {
        try { bot.setControlState(ctrl, false); } catch (e) {}
      });
      return;
    }

    try {
      const randomControl = controls[Math.floor(Math.random() * controls.length)];
      bot.setControlState(randomControl, true);

      const newYaw = bot.entity.yaw + 0.3;
      const newPitch = Math.sin(Date.now() / 500) * 0.2;
      bot.look(newYaw, newPitch, true);

      setTimeout(() => {
        try { bot.setControlState(randomControl, false); } catch (e) {}
      }, 1000);
    } catch (e) {}
  }, 1200);
}

function scheduleNextAntiAfk(instanceData) {
  if (instanceData.afkTimeout) clearTimeout(instanceData.afkTimeout);
  
  const randomDelay = Math.floor(Math.random() * (600000 - 300000 + 1)) + 300000;

  instanceData.afkTimeout = setTimeout(() => {
    if (instanceData.bot && instanceData.bot.entity) {
      triggerAntiAfkMovement(instanceData.bot);
    }
    scheduleNextAntiAfk(instanceData);
  }, randomDelay);
}

// --- Bot Lifecycle Management ---

function startBotInstance(options) {
  const { username, password, proxyInput, mcVersion, host, port, hffaEnabled, hffaTarget } = options;
  const proxyConfig = parseProxy(proxyInput);

  const botOpts = {
    host,
    port: parseInt(port, 10) || 25565,
    username,
    password: password || undefined,
    version: mcVersion || '1.8.9',
    viewDistance: 16,
    checkTimeoutInterval: 120000
  };

  if (proxyConfig) {
    botOpts.connect = createSocksConnect(proxyConfig, host, botOpts.port);
  }

  let instanceData = activeBots.get(username) || {
    bot: null,
    accumulatedUptime: options.accumulatedUptime || 0,
    sessionStart: null,
    afkTimeout: null,
    hffaInterval: null,
    followInterval: null,
    uptimeTracker: null,
    reconnectTimer: null,
    chatLogs: [],
    options
  };

  let bot;
  try {
    bot = mineflayer.createBot(botOpts);
  } catch (err) {
    console.error(`[${username}] Init error:`, err.message);
    handleFailureAndReconnect(options, instanceData);
    return;
  }

  instanceData.bot = bot;
  activeBots.set(username, instanceData);

  const allBots = readDb(BOTS_FILE);
  allBots[username] = { ...options, accumulatedUptime: instanceData.accumulatedUptime };
  writeDb(BOTS_FILE, allBots);

  bot.on('messagestr', (message) => {
    try {
      if (message && message.trim().length > 0) {
        instanceData.chatLogs.push(message);
        if (instanceData.chatLogs.length > 50) instanceData.chatLogs.shift();
      }
    } catch (e) {}
  });

  bot.once('spawn', () => {
    console.log(`[Bot ${username}] Spawned into ${host}:${botOpts.port}`);
    instanceData.sessionStart = Date.now();

    if (instanceData.uptimeTracker) clearInterval(instanceData.uptimeTracker);
    instanceData.uptimeTracker = setInterval(() => {
      if (instanceData.sessionStart) {
        const currentSession = Date.now() - instanceData.sessionStart;
        const totalUptime = instanceData.accumulatedUptime + currentSession;

        if (totalUptime >= TARGET_AFK_MS) {
          console.log(`[Bot ${username}] Target reached (20h 1m). Moving to Successfully AFK.`);
          completeAfkTarget(username, options, totalUptime);
        }
      }
    }, 5000);

    if (password) {
      setTimeout(() => { if (bot?.chat) bot.chat(`/register ${password} ${password}`); }, 1500);
      setTimeout(() => { if (bot?.chat) bot.chat(`/login ${password}`); }, 3500);
    }

    scheduleNextAntiAfk(instanceData);

    // Dynamic Staff Evasion Check
    bot.on('playerJoined', (player) => {
      if (player && checkIsStaff(player.username)) {
        console.warn(`[STAFF EVASION ALERT] ${player.username} joined! Disconnecting ${username}...`);
        safelyDisconnectBot(username, 'Staff member detected');
      }
    });

    if (hffaEnabled) {
      setTimeout(async () => {
        try {
          for (const slot of ['head', 'torso', 'legs', 'feet']) {
            if (bot) await bot.unequip(slot).catch(() => {});
          }
        } catch (e) {}
      }, 3000);

      if (instanceData.hffaInterval) clearInterval(instanceData.hffaInterval);
      instanceData.hffaInterval = setInterval(() => {
        if (bot?.chat) bot.chat('/play hardcoreffa');
      }, 60000);

      if (hffaTarget) {
        if (instanceData.followInterval) clearInterval(instanceData.followInterval);
        instanceData.followInterval = setInterval(() => {
          try {
            if (bot?.entity && bot.players[hffaTarget]?.entity) {
              const targetEntity = bot.players[hffaTarget].entity;
              bot.lookAt(targetEntity.position.offset(0, targetEntity.height, 0));
              bot.setControlState('forward', true);
              if (bot.entity.position.distanceTo(targetEntity.position) < 3) {
                bot.setControlState('forward', false);
              }
            } else if (bot) {
              bot.setControlState('forward', false);
            }
          } catch (e) {}
        }, 1000);
      }
    }
  });

  const handleDisconnect = (err) => {
    if (instanceData.sessionStart) {
      instanceData.accumulatedUptime += Date.now() - instanceData.sessionStart;
      instanceData.sessionStart = null;
    }

    if (instanceData.afkTimeout) clearTimeout(instanceData.afkTimeout);
    if (instanceData.hffaInterval) clearInterval(instanceData.hffaInterval);
    if (instanceData.followInterval) clearInterval(instanceData.followInterval);
    if (instanceData.uptimeTracker) clearInterval(instanceData.uptimeTracker);

    console.log(`[Bot ${username}] Disconnected. Saved Uptime: ${formatUptime(instanceData.accumulatedUptime)}`);
    handleFailureAndReconnect(options, instanceData);
  };

  bot.on('kicked', handleDisconnect);
  bot.on('error', handleDisconnect);
  bot.on('end', handleDisconnect);
}

async function handleFailureAndReconnect(options, instanceData) {
  const { username, proxyInput } = options;
  const proxyConfig = parseProxy(proxyInput);

  const isProxyAlive = await checkProxyAlive(proxyConfig);

  if (!isProxyAlive) {
    console.error(`[PROXY DOWN] Proxy ${proxyInput} for ${username} is offline. Moving to Proxy Down queue.`);
    
    activeBots.delete(username);
    const activeDb = readDb(BOTS_FILE);
    delete activeDb[username];
    writeDb(BOTS_FILE, activeDb);

    const downDb = readDb(PROXY_DOWN_FILE);
    downDb[username] = {
      ...options,
      accumulatedUptime: instanceData ? instanceData.accumulatedUptime : 0,
      downTimestamp: Date.now()
    };
    writeDb(PROXY_DOWN_FILE, downDb);
  } else {
    if (instanceData && instanceData.reconnectTimer) clearTimeout(instanceData.reconnectTimer);
    if (instanceData) {
      instanceData.reconnectTimer = setTimeout(() => {
        if (activeBots.has(username)) startBotInstance(options);
      }, 25000);
    }
  }
}

function completeAfkTarget(username, options, totalUptime) {
  safelyDisconnectBot(username, 'Completed 20h 1m AFK target');

  const successDb = readDb(SUCCESS_AFK_FILE);
  successDb[username] = {
    ...options,
    totalUptime,
    completedAt: new Date().toISOString()
  };
  writeDb(SUCCESS_AFK_FILE, successDb);
}

function safelyDisconnectBot(username, reason) {
  const instanceData = activeBots.get(username);
  if (!instanceData) return;

  if (instanceData.sessionStart) {
    instanceData.accumulatedUptime += Date.now() - instanceData.sessionStart;
  }

  if (instanceData.reconnectTimer) clearTimeout(instanceData.reconnectTimer);
  if (instanceData.afkTimeout) clearTimeout(instanceData.afkTimeout);
  if (instanceData.hffaInterval) clearInterval(instanceData.hffaInterval);
  if (instanceData.followInterval) clearInterval(instanceData.followInterval);
  if (instanceData.uptimeTracker) clearInterval(instanceData.uptimeTracker);

  if (instanceData.bot) {
    try { instanceData.bot.quit(); } catch (e) {}
  }

  activeBots.delete(username);
  const activeDb = readDb(BOTS_FILE);
  delete activeDb[username];
  writeDb(BOTS_FILE, activeDb);
}

// --- REST Endpoints: Staff Evasion ---

app.get('/api/staff', (req, res) => {
  res.json({ staff: getStaffList() });
});

app.post('/api/staff/add', (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'Please provide a valid staff username or keyword.' });
  }

  const staffList = getStaffList();
  const cleanName = username.trim().toLowerCase();

  if (staffList.includes(cleanName)) {
    return res.status(400).json({ error: 'Name already exists in staff evasion list.' });
  }

  staffList.push(cleanName);
  saveStaffList(staffList);
  res.json({ success: true, message: `Added '${cleanName}' to staff evasion list.`, staff: staffList });
});

app.post('/api/staff/remove', (req, res) => {
  const { username } = req.body;
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Please provide a valid staff username.' });
  }

  let staffList = getStaffList();
  const cleanName = username.trim().toLowerCase();

  if (!staffList.includes(cleanName)) {
    return res.status(400).json({ error: 'Name not found in staff evasion list.' });
  }

  staffList = staffList.filter((item) => item !== cleanName);
  saveStaffList(staffList);
  res.json({ success: true, message: `Removed '${cleanName}' from staff evasion list.`, staff: staffList });
});

// --- REST Endpoint: Proxy Checker ---

app.post('/api/check-proxy', async (req, res) => {
  const { proxy } = req.body;
  const parsed = parseProxy(proxy);

  if (!parsed) {
    return res.status(400).json({ error: 'Invalid proxy format. Use host:port or host:port:user:pass' });
  }

  const authString = parsed.userId && parsed.password ? `${parsed.userId}:${parsed.password}@` : '';
  const socksUrl = `socks5://${authString}${parsed.host}:${parsed.port}`;
  const agent = new SocksProxyAgent(socksUrl);

  const endpointIps = [];

  for (let i = 0; i < 5; i++) {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', {
        httpAgent: agent,
        httpsAgent: agent,
        timeout: 7000
      });
      if (response.data && response.data.ip) {
        endpointIps.push(response.data.ip);
      }
    } catch (err) {
      endpointIps.push(`Failed Request (${err.message})`);
    }
  }

  const validIps = endpointIps.filter((ip) => !ip.startsWith('Failed'));

  if (validIps.length === 0) {
    return res.json({
      success: false,
      proxy,
      type: 'dead',
      message: 'Proxy failed all 5 requests',
      requests: endpointIps
    });
  }

  const allSame = validIps.every((ip) => ip === validIps[0]);
  const proxyType = allSame ? 'sticky' : 'rotating';

  res.json({
    success: true,
    proxy,
    type: proxyType,
    endpointIps
  });
});

// --- Other Endpoints ---

app.post('/api/bots/add', (req, res) => {
  const { username, password, proxyInput, mcVersion, host, port, hffaEnabled, hffaTarget } = req.body;
  if (!username || !host) {
    return res.status(400).json({ error: 'Username and host are required.' });
  }

  const options = {
    username,
    password,
    proxyInput,
    mcVersion: mcVersion || '1.8.9',
    host,
    port: port || 25565,
    hffaEnabled: !!hffaEnabled,
    hffaTarget,
    accumulatedUptime: 0
  };

  startBotInstance(options);
  res.json({ success: true, message: `Bot ${username} starting...` });
});

app.post('/api/bots/stop', (req, res) => {
  const { username } = req.body;
  safelyDisconnectBot(username, 'Manual stop');
  res.json({ success: true, message: `Bot ${username} stopped.` });
});

app.get('/api/proxy-down', (req, res) => {
  const downDb = readDb(PROXY_DOWN_FILE);
  const list = Object.entries(downDb).map(([username, data]) => ({
    username,
    password: data.password,
    lastProxy: data.proxyInput,
    accumulatedUptime: formatUptime(data.accumulatedUptime || 0),
    downSince: new Date(data.downTimestamp).toLocaleString()
  }));
  res.json(list);
});

app.post('/api/revive-proxies', (req, res) => {
  const { revivals } = req.body;

  if (!Array.isArray(revivals) || revivals.length === 0 || revivals.length > 4) {
    return res.status(400).json({ error: 'Provide an array of 1 to 4 bot revival entries.' });
  }

  const downDb = readDb(PROXY_DOWN_FILE);
  const results = [];

  for (const entry of revivals) {
    const { username, newProxy } = entry;
    const botRecord = downDb[username];

    if (!botRecord) {
      results.push({ username, success: false, reason: 'Bot not found in Proxy Down queue' });
      continue;
    }

    const updatedOptions = {
      ...botRecord,
      proxyInput: newProxy
    };

    delete downDb[username];
    startBotInstance(updatedOptions);
    results.push({ username, success: true, newProxy });
  }

  writeDb(PROXY_DOWN_FILE, downDb);
  res.json({ success: true, results });
});

app.get('/api/successfully-afk', (req, res) => {
  const successDb = readDb(SUCCESS_AFK_FILE);
  res.json(successDb);
});

app.get('/api/status', (req, res) => {
  const statuses = [];
  activeBots.forEach((data, username) => {
    const { bot, sessionStart, accumulatedUptime, options, chatLogs } = data;

    const currentSession = sessionStart ? Date.now() - sessionStart : 0;
    const totalActiveUptime = accumulatedUptime + currentSession;

    let health = 'N/A';
    let food = 'N/A';

    if (bot) {
      if (typeof bot.health === 'number') health = bot.health.toFixed(1);
      if (typeof bot.food === 'number') food = bot.food.toFixed(1);
    }

    statuses.push({
      username,
      host: `${options.host}:${options.port}`,
      activeUptime: formatUptime(totalActiveUptime),
      health,
      food,
      proxy: options.proxyInput ? options.proxyInput.split(':')[0] : 'Direct Connection',
      hffaActive: !!options.hffaEnabled,
      chatLogs: chatLogs.slice(-10)
    });
  });
  res.json(statuses);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dark AFK] Server online on port ${PORT}`);

  const savedBots = readDb(BOTS_FILE);
  for (const [username, config] of Object.entries(savedBots)) {
    startBotInstance(config);
  }
});
                  
