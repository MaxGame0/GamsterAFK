const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dns = require('dns');
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

const DEFAULT_STAFF_LIST = [
  'henriks9', 'seeken', 'akyss', 'lupu_xx_x', 'ionutz547', 'andreibeni',
  'snaccks', 'gr_veteran', 'osmiumredox', 'bombita_01', 'ld007', 'space_turtle9',
  'urswu', 'gamsterevent', 'xspeed10', 'fredy_9', 'weepinangels', 'h2mzh',
  'doritostar', 'athul', 'godkissed', 'synchitss', '_pixelwarrioryt_', 'karlthhkiller3',
  'pintux', 'wost_ali', 'robi5937', 'mihaaiiii', 'megasus', 'theashz',
  'tini_alina', 'gamster', 'itsb2_', 'officialmex', 'nayskutzu', 'maria_int'
];

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
  try {
    if (fs.existsSync(STAFF_FILE)) {
      return JSON.parse(fs.readFileSync(STAFF_FILE, 'utf8'));
    }
    fs.writeFileSync(STAFF_FILE, JSON.stringify(DEFAULT_STAFF_LIST, null, 2));
    return DEFAULT_STAFF_LIST;
  } catch (err) {
    return DEFAULT_STAFF_LIST;
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

function formatErrorMsg(err) {
  if (!err) return 'Connection closed / Socket ended';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch (e) {
    return 'Unknown connection error';
  }
}

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
    agent = new SocksProxyAgent(proxyUrl, { timeout: 8000 });
  } catch (e) {
    return { type: 'ERROR', ips: [], success: false, reason: 'Agent Creation Failed' };
  }

  const endpoint = 'https://api.ipify.org?format=json';
  const ips = [];

  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.get(endpoint, {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: 6000
      });
      if (res.data && res.data.ip) {
        ips.push(res.data.ip);
      }
    } catch (err) {}
  }

  if (ips.length === 0) {
    return { type: 'UNCHECKED / RAW TCP ONLY', ips: [], success: false, reason: 'HTTP test failed but proxy port may be open' };
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

function checkProxyAlive(proxyConfig) {
  return new Promise((resolve) => {
    if (!proxyConfig) return resolve(true);

    const socket = new net.Socket();
    socket.setTimeout(7000);

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
    dns.lookup(targetHost, { family: 4 }, (dnsErr, targetIp) => {
      const destinationHost = (!dnsErr && targetIp) ? targetIp : targetHost;

      const options = {
        proxy: {
          host: proxyConfig.host,
          port: proxyConfig.port,
          type: 5
        },
        command: 'connect',
        destination: {
          host: destinationHost,
          port: targetPort
        },
        timeout: 25000
      };

      if (proxyConfig.userId && proxyConfig.password) {
        options.proxy.userId = proxyConfig.userId;
        options.proxy.password = proxyConfig.password;
      }

      SocksClient.createConnection(options)
        .then((info) => {
          info.socket.on('error', (err) => {
            clientInstance.emit('error', new Error(`Proxy Socket Error: ${formatErrorMsg(err)}`));
          });
          clientInstance.setSocket(info.socket);
          clientInstance.emit('connect');
        })
        .catch((err) => {
          clientInstance.emit('error', new Error(`SOCKS5 Handshake Failed: ${formatErrorMsg(err)}`));
        });
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

  const targetHost = host || 'gamester.org';
  const targetPort = parseInt(port, 10) || 25565;

  const botOpts = {
    host: targetHost,
    port: targetPort,
    username,
    version: mcVersion || '1.8.9',
    viewDistance: 16
  };

  if (proxyConfig) {
    botOpts.connect = createSocksConnect(proxyConfig, targetHost, targetPort);
  }

  let instanceData = activeBots.get(username) || {
    bot: null,
    accumulatedUptime: options.accumulatedUptime || 0,
    sessionStart: null,
    disconnectCount: 0,
    systemLogs: [],
    proxyType: proxyInput ? 'UNKNOWN' : 'DIRECT',
    moveTimeout: null,
    moveDurationTimeout: null,
    isDisconnecting: false,
    options
  };

  instanceData.options = { ...options, accumulatedUptime: instanceData.accumulatedUptime };
  instanceData.isDisconnecting = false;

  let bot;
  try {
    bot = mineflayer.createBot(botOpts);
  } catch (err) {
    handleBotDisconnect(options, instanceData, formatErrorMsg(err));
    return;
  }

  instanceData.bot = bot;
  activeBots.set(username, instanceData);

  bot.once('spawn', () => {
    instanceData.sessionStart = Date.now();
    instanceData.disconnectCount = 0;
    logSystemMessage(instanceData, 'STATUS: Bot successfully spawned in game.');

    if (password) {
      setTimeout(() => bot?.chat(`/register ${password} ${password}`), 1500);
      setTimeout(() => bot?.chat(`/login ${password}`), 3500);
    }

    startHumanMovementRoutine(bot, instanceData);

    bot.on('playerJoined', (player) => {
      if (player && player.username && checkIsStaff(player.username)) {
        logSystemMessage(instanceData, `STAFF TAB DETECTED: Staff '${player.username}' joined tab list! Disconnecting for 15s...`);
        disconnectAndReconnectForStaff(options, instanceData);
      }
    });
  });

  bot.on('kicked', (reason) => {
    const reasonStr = formatErrorMsg(reason);
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

  bot.on('error', (err) => {
    handleBotDisconnect(options, instanceData, formatErrorMsg(err));
  });

  bot.on('end', (reason) => {
    handleBotDisconnect(options, instanceData, formatErrorMsg(reason));
  });
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

async function handleBotDisconnect(options, instanceData, rawError) {
  if (instanceData.isDisconnecting) return;
  instanceData.isDisconnecting = true;

  const { username, proxyInput } = options;
  const errorMsg = formatErrorMsg(rawError);

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

  if (instanceData.disconnectCount >= 5) {
    logSystemMessage(instanceData, 'SYSTEM: 5 disconnects reached. Verifying proxy health...');

    const proxyConfig = parseProxy(proxyInput);
    const isProxyAlive = await checkProxyAlive(proxyConfig);

    if (proxyInput) {
      const typeRes = await checkProxyType5Req(proxyInput);
      instanceData.proxyType = typeRes.type;
      logSystemMessage(instanceData, `PROXY CHECK: Status is ${typeRes.type}`);
    }

    if (!isProxyAlive) {
      logSystemMessage(instanceData, 'SYSTEM: Proxy check FAILED (DEAD / NO TCP CONNECTION). Moving bot to Proxy Down section.');
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
      logSystemMessage(instanceData, 'SYSTEM: Proxy TCP Port is ALIVE. Resetting disconnect counter from 5 to 0.');
      instanceData.disconnectCount = 0;
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

  bots.forEach((item, index) => {
    if (item.username) {
      setTimeout(() => {
        startBotInstance({ ...item, accumulatedUptime: 0 });
      }, index * 5000);
    }
  });

  res.json({ success: true, message: `Queued ${bots.length} bots with 5-second staggered delays.` });
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
      proxyType: data.proxyType || 'UNKNOWN',
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

  usernames.forEach((username, index) => {
    if (downDb[username]) {
      const botData = downDb[username];
      delete downDb[username];

      const updatedOptions = {
        ...botData,
        proxyInput: newProxy,
        accumulatedUptime: botData.accumulatedUptime || 0
      };

      setTimeout(() => {
        startBotInstance(updatedOptions);
      }, index * 5000);

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
