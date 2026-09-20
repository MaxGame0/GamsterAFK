const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const net = require('net');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

const PROXY_DOWN_FILE = './proxy_down_db.json';
const SUCCESS_AFK_FILE = './success_afk_db.json';
const BANNED_BOTS_FILE = './banned_bots_db.json';
const STAFF_FILE = './staff_db.json';

const SUCCESS_AFK_THRESHOLD_MS = (20 * 60 + 1) * 60 * 1000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeBots = new Map();

function readDb(filePath) {
  try {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {}
  return {};
}

function writeDb(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (err) {}
}

function getStaffList() {
  const defaultStaff = ['staff', 'admin', 'mod', 'helper', 'owner', 'henriks9'];
  try {
    if (fs.existsSync(STAFF_FILE)) {
      return JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8'));
    }
    fs.writeFileSync(STAFF_FILE, JSON.stringify(defaultStaff, null, 2));
    return defaultStaff;
  } catch (err) {
    return defaultStaff;
  }
}

function saveStaffList(list) {
  try {
    fs.writeFileSync(STAFF_FILE, JSON.stringify(list, null, 2));
  } catch (err) {}
}

function checkIsStaff(username) {
  if (!username) return false;
  const lower = username.toLowerCase();
  const staffList = getStaffList();
  return staffList.some((kw) => lower.includes(kw.toLowerCase()));
}

function parseProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  const parts = proxyStr.trim().split(':');
  if (parts.length >= 4) {
    return { host: parts[0], port: parseInt(parts[1], 10), userId: parts[2], password: parts.slice(3).join(':') };
  } else if (parts.length === 2) {
    return { host: parts[0], port: parseInt(parts[1], 10) };
  }
  return null;
}

// 5-Request Proxy Type Checker Function
async function checkProxyType5Req(proxyStr) {
  const proxyConfig = parseProxy(proxyStr);
  if (!proxyConfig) return { type: 'DIRECT', ips: [], success: false, reason: 'Invalid or No Proxy Format' };

  let authPart = '';
  if (proxyConfig.userId && proxyConfig.password) {
    authPart = `${proxyConfig.userId}:${proxyConfig.password}@`;
  }
  const proxyUrl = `socks5://${authPart}${proxyConfig.host}:${proxyConfig.port}`;
  
  let agent;
  try {
    agent = new SocksProxyAgent(proxyUrl);
  } catch (e) {
    return { type: 'ERROR', ips: [], success: false, reason: 'Agent Creation Failed' };
  }

  const endpoint = 'https://api.ipify.org?format=json';
  const ips = [];

  for (let i = 0; i < 5; i++) {
    try {
      const res = await axios.get(endpoint, {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: 4000
      });
      if (res.data && res.data.ip) {
        ips.push(res.data.ip);
      }
    } catch (err) {}
  }

  if (ips.length === 0) {
    return { type: 'DEAD / OFFLINE', ips: [], success: false, reason: 'All 5 requests failed' };
  }

  const uniqueIPs = new Set(ips);
  const type = uniqueIPs.size > 1 ? 'ROTATING' : 'STATIC';

  return {
    type,
    ips,
    uniqueCount: uniqueIPs.size,
    successCount: ips.length,
    success: true
  };
}

// Check proxy socket connectivity & internet routing
function checkProxyAlive(proxyConfig) {
  return new Promise((resolve) => {
    if (!proxyConfig) return resolve(true);
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
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
        clientInstance.emit('error', new Error(`SOCKS5 Error: ${err.message}`));
      });
  };
}

function formatUptime(ms) {
  const totalSecs = Math.floor(ms / 1000);
  const seconds = totalSecs % 60;
  const minutes = Math.floor((totalSecs / 60) % 60);
  const hours = Math.floor(totalSecs / 3600);
  return `${hours}h ${minutes}m ${seconds}s`;
}

function logSystemMessage(instanceData, msg) {
  const timestamp = new Date().toLocaleTimeString();
  instanceData.systemLogs.push(`[${timestamp}] ${msg}`);
  if (instanceData.systemLogs.length > 100) instanceData.systemLogs.shift();
}

function startHumanMovementRoutine(bot, instanceData) {
  const scheduleNext = () => {
    const delay = Math.floor(Math.random() * (600000 - 300000 + 1)) + 300000;
    instanceData.moveTimeout = setTimeout(() => executeMovement(), delay);
  };

  const executeMovement = () => {
    if (!bot || !bot.entity) return scheduleNext();

    const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];
    const activeControls = [];

    for (let i = 0; i < 3; i++) {
      const randomControl = controls[Math.floor(Math.random() * controls.length)];
      bot.setControlState(randomControl, true);
      activeControls.push(randomControl);
    }

    const yawChange = (Math.random() - 0.5) * Math.PI;
    const pitchChange = (Math.random() - 0.5) * (Math.PI / 2);
    try {
      bot.look(bot.entity.yaw + yawChange, bot.entity.pitch + pitchChange, false);
    } catch (e) {}

    instanceData.moveDurationTimeout = setTimeout(() => {
      activeControls.forEach((ctrl) => bot.setControlState(ctrl, false));
      scheduleNext();
    }, 15000);
  };

  scheduleNext();
}

function startBotInstance(options) {
  const { username, password, proxyInput, mcVersion, host, port } = options;
  const proxyConfig = parseProxy(proxyInput);

  const botOpts = {
    host: host || 'gamester.org',
    port: parseInt(port, 10) || 25565,
    username,
    version: mcVersion || '1.8.9',
    viewDistance: 16
  };

  if (proxyConfig) botOpts.connect = createSocksConnect(proxyConfig, botOpts.host, botOpts.port);

  let instanceData = activeBots.get(username) || {
    bot: null,
    accumulatedUptime: options.accumulatedUptime || 0,
    sessionStart: null,
    disconnectCount: 0,
    systemLogs: [],
    proxyType: 'CHECKING...',
    moveTimeout: null,
    moveDurationTimeout: null,
    options
  };

  instanceData.options = { ...options, accumulatedUptime: instanceData.accumulatedUptime };

  if (proxyInput) {
    checkProxyType5Req(proxyInput).then(res => {
      instanceData.proxyType = res.type;
      logSystemMessage(instanceData, `PROXY CHECK (5 Reqs): Type is ${res.type} (${res.successCount}/5 successful IPs: ${res.ips.join(', ')})`);
    });
  } else {
    instanceData.proxyType = 'DIRECT';
  }

  let bot;
  try {
    bot = mineflayer.createBot(botOpts);
  } catch (err) {
    handleBotDisconnect(options, instanceData, err.message);
    return;
  }

  instanceData.bot = bot;
  activeBots.set(username, instanceData);

  bot.once('spawn', () => {
    instanceData.sessionStart = Date.now();
    logSystemMessage(instanceData, 'STATUS: Bot successfully spawned in game.');

    if (password) {
      setTimeout(() => bot?.chat(`/register ${password} ${password}`), 1500);
      setTimeout(() => bot?.chat(`/login ${password}`), 3500);
    }

    startHumanMovementRoutine(bot, instanceData);

    bot.on('playerJoined', (player) => {
      if (player && checkIsStaff(player.username)) {
        logSystemMessage(instanceData, `STAFF DETECTION: Staff member '${player.username}' detected! Disconnecting for 15 seconds...`);
        disconnectAndReconnectForStaff(options, instanceData);
      }
    });
  });

  bot.on('kicked', (reason) => {
    const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason);
    if (reasonStr.toLowerCase().includes('ban') || reasonStr.toLowerCase().includes('blacklisted')) {
      const bannedDb = readDb(BANNED_BOTS_FILE);
      bannedDb[username] = {
        ...options,
        password: password || 'N/A',
        uptime: formatUptime(instanceData.accumulatedUptime),
        reason: reasonStr,
        date: new Date().toISOString()
      };
      writeDb(BANNED_BOTS_FILE, bannedDb);
      logSystemMessage(instanceData, `BANNED: Account banned. Details: ${reasonStr}`);
      safelyDisconnectBot(username, 'Banned');
      return;
    }
    handleBotDisconnect(options, instanceData, `Kicked: ${reasonStr}`);
  });

  const onEndOrError = (err) => {
    handleBotDisconnect(options, instanceData, err ? err.message : 'Connection dropped');
  };

  bot.on('error', onEndOrError);
  bot.on('end', onEndOrError);
}

function clearMovementTimers(instanceData) {
  if (instanceData.moveTimeout) clearTimeout(instanceData.moveTimeout);
  if (instanceData.moveDurationTimeout) clearTimeout(instanceData.moveDurationTimeout);
}

function disconnectAndReconnectForStaff(options, instanceData) {
  clearMovementTimers(instanceData);
  if (instanceData.sessionStart) {
    instanceData.accumulatedUptime += (Date.now() - instanceData.sessionStart);
    instanceData.sessionStart = null;
  }
  
  if (instanceData.bot) {
    try { instanceData.bot.quit(); } catch (e) {}
    instanceData.bot = null;
  }

  logSystemMessage(instanceData, 'STAFF PROTECTION: Disconnected. Waiting 15 seconds to reconnect...');

  setTimeout(() => {
    if (activeBots.has(options.username)) {
      logSystemMessage(instanceData, 'STAFF PROTECTION: 15 seconds elapsed. Reconnecting bot now...');
      startBotInstance(options);
    }
  }, 15000);
}

async function handleBotDisconnect(options, instanceData, errorMsg) {
  const { username, proxyInput } = options;

  clearMovementTimers(instanceData);

  if (instanceData.sessionStart) {
    instanceData.accumulatedUptime += (Date.now() - instanceData.sessionStart);
    instanceData.sessionStart = null;
    instanceData.options.accumulatedUptime = instanceData.accumulatedUptime;
  }

  if (instanceData.accumulatedUptime >= SUCCESS_AFK_THRESHOLD_MS) {
    const afkDb = readDb(SUCCESS_AFK_FILE);
    afkDb[username] = {
      ...options,
      password: options.password || 'N/A',
      uptime: formatUptime(instanceData.accumulatedUptime),
      accumulatedUptime: instanceData.accumulatedUptime,
      date: new Date().toISOString()
    };
    writeDb(SUCCESS_AFK_FILE, afkDb);
    logSystemMessage(instanceData, 'SUCCESS: Bot reached 20 hours and 1 minute AFK target!');
  }

  instanceData.disconnectCount += 1;
  logSystemMessage(instanceData, `DISCONNECT ATTEMPT #${instanceData.disconnectCount}: ${errorMsg}`);

  // ONLY CHECK PROXY WHEN 5 DISCONNECTS ARE REACHED
  if (instanceData.disconnectCount >= 5) {
    logSystemMessage(instanceData, 'SYSTEM: 5 disconnects reached. Verifying proxy health & network connectivity...');
    const proxyConfig = parseProxy(proxyInput);
    const isProxyAlive = await checkProxyAlive(proxyConfig);

    if (!isProxyAlive) {
      logSystemMessage(instanceData, 'SYSTEM: Proxy check FAILED (DEAD / NO NETWORK). Moving bot to Proxy Down section.');
      activeBots.delete(username);
      const downDb = readDb(PROXY_DOWN_FILE);
      downDb[username] = {
        ...options,
        password: options.password || 'N/A',
        uptime: formatUptime(instanceData.accumulatedUptime),
        accumulatedUptime: instanceData.accumulatedUptime,
        downTimestamp: new Date().toISOString(),
        error: errorMsg
      };
      writeDb(PROXY_DOWN_FILE, downDb);
      return;
    } else {
      // PROXY IS ALIVE AND HAS NETWORK -> RESET ATTEMPT COUNTER BACK TO 0
      logSystemMessage(instanceData, 'SYSTEM: Proxy is ALIVE and has network access. Resetting disconnect counter from 5 to 0. Reconnecting...');
      instanceData.disconnectCount = 0; // <--- RESET TO 0 HERE
    }
  }

  setTimeout(() => {
    if (activeBots.has(username)) {
      startBotInstance(options);
    }
  }, 10000);
}

function safelyDisconnectBot(username, reason) {
  const instanceData = activeBots.get(username);
  if (instanceData) {
    clearMovementTimers(instanceData);
    if (instanceData.sessionStart) {
      instanceData.accumulatedUptime += (Date.now() - instanceData.sessionStart);
      instanceData.sessionStart = null;
    }
    if (instanceData.bot) {
      try { instanceData.bot.quit(); } catch (e) {}
    }
  }
  activeBots.delete(username);
}

// REST ENDPOINTS

app.post('/api/proxy/check-type', async (req, res) => {
  const { proxyInput } = req.body;
  if (!proxyInput) return res.status(400).json({ error: 'Proxy input string required' });
  const result = await checkProxyType5Req(proxyInput);
  res.json(result);
});

app.get('/api/staff', (req, res) => res.json(getStaffList()));

app.post('/api/staff/add', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Staff name required' });
  const list = getStaffList();
  const trimmed = name.trim().toLowerCase();
  if (!list.includes(trimmed)) {
    list.push(trimmed);
    saveStaffList(list);
  }
  res.json({ success: true, list });
});

app.post('/api/staff/remove', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Staff name required' });
  let list = getStaffList();
  list = list.filter((item) => item.toLowerCase() !== name.toLowerCase());
  saveStaffList(list);
  res.json({ success: true, list });
});

app.post('/api/bots/add-single', (req, res) => {
  const { username, password, proxyInput, host, port, mcVersion } = req.body;
  if (!username) return res.status(400).json({ error: 'Username is required' });
  startBotInstance({ username, password, proxyInput, host, port, mcVersion, accumulatedUptime: 0 });
  res.json({ success: true, message: `Started bot ${username}` });
});

app.post('/api/bots/add-bulk', (req, res) => {
  const { bots } = req.body;
  if (!Array.isArray(bots)) return res.status(400).json({ error: 'Invalid input' });
  bots.forEach((item) => {
    if (item.username) startBotInstance({ ...item, accumulatedUptime: 0 });
  });
  res.json({ success: true, message: `Started ${bots.length} bots.` });
});

app.post('/api/bots/stop', (req, res) => {
  safelyDisconnectBot(req.body.username, 'Manual stop');
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  const list = [];
  activeBots.forEach((data, username) => {
    const totalMs = data.accumulatedUptime + (data.sessionStart ? Date.now() - data.sessionStart : 0);
    list.push({
      username,
      password: data.options.password || 'N/A',
      host: `${data.options.host || 'gamester.org'}:${data.options.port || 25565}`,
      uptime: formatUptime(totalMs),
      proxy: data.options.proxyInput ? data.options.proxyInput.split(':')[0] : 'Direct',
      proxyType: data.proxyType || 'CHECKING...',
      disconnects: data.disconnectCount
    });
  });
  res.json(list);
});

app.get('/api/chat/:username', (req, res) => {
  const data = activeBots.get(req.params.username);
  res.json({ logs: data ? data.systemLogs : [] });
});

app.post('/api/proxy-down/revive-bulk', (req, res) => {
  const { usernames, newProxy } = req.body;
  if (!Array.isArray(usernames) || usernames.length === 0 || usernames.length > 4) {
    return res.status(400).json({ error: 'Select between 1 and 4 bots.' });
  }

  const downDb = readDb(PROXY_DOWN_FILE);
  const reconnectedBots = [];

  usernames.forEach((username) => {
    if (downDb[username]) {
      const botData = downDb[username];
      delete downDb[username];

      const updatedOptions = {
        ...botData,
        proxyInput: newProxy,
        accumulatedUptime: botData.accumulatedUptime || 0
      };

      startBotInstance(updatedOptions);
      reconnectedBots.push(username);
    }
  });

  writeDb(PROXY_DOWN_FILE, downDb);
  res.json({ success: true, reconnected: reconnectedBots });
});

app.get('/api/proxy-down', (req, res) => res.json(readDb(PROXY_DOWN_FILE)));
app.get('/api/success-afk', (req, res) => res.json(readDb(SUCCESS_AFK_FILE)));
app.get('/api/banned-bots', (req, res) => res.json(readDb(BANNED_BOTS_FILE)));

app.delete('/api/proxy-down/:username', (req, res) => {
  const db = readDb(PROXY_DOWN_FILE);
  delete db[req.params.username];
  writeDb(PROXY_DOWN_FILE, db);
  res.json({ success: true });
});

app.delete('/api/success-afk/:username', (req, res) => {
  const db = readDb(SUCCESS_AFK_FILE);
  delete db[req.params.username];
  writeDb(SUCCESS_AFK_FILE, db);
  res.json({ success: true });
});

app.delete('/api/banned-bots/:username', (req, res) => {
  const db = readDb(BANNED_BOTS_FILE);
  delete db[req.params.username];
  writeDb(BANNED_BOTS_FILE, db);
  res.json({ success: true });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
  
