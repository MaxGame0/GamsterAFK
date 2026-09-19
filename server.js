const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const socks = require('socks');
const path = require('path');

// GLOBAL ERROR GUARDS (Prevents VPS/Container Crashes)
process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught Exception:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRASH GUARD] Unhandled Rejection:', reason);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const TARGET_AFK_MS = (20 * 3600 + 10 * 60) * 1000; // 20 Hours 10 Minutes
const MAX_DROPS = 5;

let runtimeProxies = [];
let staffMembers = ['Henriks9', 'Admin', 'StaffMember'];
let activeBots = new Map();
let proxyDownList = [];
let targetCompletedList = [];
let bannedBotsList = [];
let logs = [];

function logMsg(msg, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, msg, type };
  logs.push(logEntry);
  if (logs.length > 200) logs.shift();
  io.emit('log', logEntry);
  console.log(`[${type.toUpperCase()}] ${timestamp} - ${msg}`);
}

function getProxyForBotIndex(index) {
  if (runtimeProxies.length === 0) return null;
  const proxyIndex = Math.floor(index / 4) % runtimeProxies.length;
  return runtimeProxies[proxyIndex];
}

function createBotInstance(username, password, index) {
  const assignedProxy = getProxyForBotIndex(index);
  
  const botOptions = {
    host: 'gamester.org',
    port: 25565,
    username: username,
    version: '1.8.9'
  };

  // Cloud Clusters Compatible Socks5 Handler
  if (assignedProxy) {
    const [host, port, proxyUser, proxyPass] = assignedProxy.split(':');
    botOptions.connect = (client) => {
      socks.SocksClient.createConnection({
        proxy: {
          host: host,
          port: parseInt(port, 10),
          type: 5,
          userId: proxyUser || '',
          password: proxyPass || ''
        },
        command: 'connect',
        destination: { host: 'gamester.org', port: 25565 }
      }, (err, info) => {
        if (err) {
          logMsg(`Proxy connection error for ${username}: ${err.message}`, 'error');
          handleBotDrop(username);
          return;
        }
        client.setSocket(info.socket);
        client.emit('connect');
      });
    };
  }

  const bot = mineflayer.createBot(botOptions);

  const botData = {
    username,
    password,
    proxy: assignedProxy || 'Direct / None',
    ping: 40,
    dropCount: 0,
    afkStartTime: Date.now(),
    afkDurationMs: 0,
    status: 'Connecting',
    isLoggedIn: false,
    instance: bot
  };

  activeBots.set(username, botData);

  bot._client.on('packet', (data, meta) => {
    if (meta.name === 'player_info' && data.action === 0 && data.data) {
      for (const p of data.data) {
        if (p.name) checkStaffEvasion(username, p.name);
      }
    }
    if (meta.name === 'chat' || meta.name === 'systemChat') {
      try {
        const rawJson = JSON.parse(data.message || data.content || '{}');
        const text = rawJson.text || JSON.stringify(rawJson);
        handleChatPrompts(username, text);
        checkStaffEvasion(username, text);
      } catch (e) {
        if (typeof data.message === 'string') {
          handleChatPrompts(username, data.message);
          checkStaffEvasion(username, data.message);
        }
      }
    }
  });

  bot.on('spawn', () => {
    botData.status = 'Online (In Hub)';
    logMsg(`Bot ${username} spawned in server.`, 'success');
  });

  bot.on('chat', (usernameMsg, message) => {
    handleChatPrompts(username, message);
    checkStaffEvasion(username, message);
  });

  const pingInterval = setInterval(() => {
    if (!activeBots.has(username)) return clearInterval(pingInterval);
    const latency = bot.player?.ping || bot._client?.latency || Math.floor(Math.random() * 15 + 35);
    botData.ping = latency;

    if (botData.isLoggedIn) {
      botData.afkDurationMs = Date.now() - botData.afkStartTime;
      if (botData.afkDurationMs >= TARGET_AFK_MS) {
        completeTargetAfk(username);
      }
    }
    broadcastState();
  }, 3000);

  bot.on('kicked', (reason) => {
    const reasonStr = typeof reason === 'object' ? JSON.stringify(reason) : String(reason);
    logMsg(`Bot ${username} kicked: ${reasonStr}`, 'warn');
    
    if (reasonStr.toLowerCase().includes('ban') || reasonStr.toLowerCase().includes('blacklisted')) {
      handleBannedBot(username, reasonStr);
    } else {
      handleBotDrop(username);
    }
  });

  bot.on('error', (err) => {
    logMsg(`Bot ${username} error: ${err.message}`, 'error');
    handleBotDrop(username);
  });

  bot.on('end', () => {
    logMsg(`Bot ${username} disconnected.`, 'warn');
    clearInterval(pingInterval);
  });
}

function handleChatPrompts(username, text) {
  const botData = activeBots.get(username);
  if (!botData || !botData.instance) return;
  const bot = botData.instance;

  const lower = text.toLowerCase();
  if (lower.includes('/register')) {
    bot.chat(`/register ${botData.password} ${botData.password}`);
    botData.status = 'Registered & Logging In';
  } else if (lower.includes('/login')) {
    bot.chat(`/login ${botData.password}`);
    botData.status = 'Logged In (AFK Active)';
    botData.isLoggedIn = true;
    botData.afkStartTime = Date.now();
    scheduleAntiAfk(username);
  }
}

function scheduleAntiAfk(username) {
  const delay = Math.floor(Math.random() * (600000 - 300000 + 1)) + 300000;
  setTimeout(() => {
    const botData = activeBots.get(username);
    if (!botData || !botData.instance || !botData.isLoggedIn) return;

    const bot = botData.instance;
    const actions = ['forward', 'back', 'left', 'right'];
    const chosenAction = actions[Math.floor(Math.random() * actions.length)];
    const duration = Math.floor(Math.random() * (7000 - 3000 + 1)) + 3000;

    bot.setControlState(chosenAction, true);
    if (Math.random() > 0.5) bot.setControlState('jump', true);
    if (Math.random() > 0.5) bot.setControlState('sprint', true);

    const yaw = (Math.random() * 360 - 180) * (Math.PI / 180);
    const pitch = (Math.random() * 60 - 30) * (Math.PI / 180);
    bot.look(yaw, pitch, true);

    setTimeout(() => {
      if (bot.clearControlStates) bot.clearControlStates();
      scheduleAntiAfk(username);
    }, duration);
  }, delay);
}

function checkStaffEvasion(username, textOrPlayerName) {
  const foundStaff = staffMembers.find(staff => 
    textOrPlayerName.toLowerCase().includes(staff.toLowerCase())
  );

  if (foundStaff) {
    logMsg(`STAFF ALERT: ${foundStaff} detected near ${username}! Disconnecting.`, 'error');
    const botData = activeBots.get(username);
    if (botData && botData.instance) {
      botData.instance.quit();
      activeBots.delete(username);
      broadcastState();
    }
  }
}

function handleBotDrop(username) {
  const botData = activeBots.get(username);
  if (!botData) return;

  botData.dropCount += 1;
  logMsg(`Bot ${username} drop count: ${botData.dropCount}/${MAX_DROPS}`, 'warn');

  if (botData.dropCount >= MAX_DROPS) {
    logMsg(`Bot ${username} reached drop limit (${MAX_DROPS}). Moving to Proxy Down.`, 'error');
    proxyDownList.push({
      username: botData.username,
      proxy: botData.proxy,
      reason: `Exceeded ${MAX_DROPS} connection drops`,
      timestamp: new Date().toLocaleTimeString()
    });
    if (botData.instance) botData.instance.quit();
    activeBots.delete(username);
  }
  broadcastState();
}

function handleBannedBot(username, reason) {
  const botData = activeBots.get(username);
  if (botData) {
    bannedBotsList.push({
      username: botData.username,
      proxy: botData.proxy,
      reason,
      timestamp: new Date().toLocaleTimeString()
    });
    if (botData.instance) botData.instance.quit();
    activeBots.delete(username);
  }
  broadcastState();
}

function completeTargetAfk(username) {
  const botData = activeBots.get(username);
  if (botData) {
    logMsg(`TARGET ACHIEVED: Bot ${username} completed 20h 10m AFK!`, 'success');
    targetCompletedList.push({
      username: botData.username,
      proxy: botData.proxy,
      totalTime: '20h 10m 00s',
      completedAt: new Date().toLocaleTimeString()
    });
    if (botData.instance) botData.instance.quit();
    activeBots.delete(username);
  }
  broadcastState();
}

function broadcastState() {
  const botsArray = Array.from(activeBots.values()).map(b => ({
    username: b.username,
    proxy: b.proxy,
    ping: b.ping,
    dropCount: b.dropCount,
    afkDurationMs: b.afkDurationMs,
    status: b.status,
    isLoggedIn: b.isLoggedIn
  }));

  io.emit('state_update', {
    bots: botsArray,
    staff: staffMembers,
    proxyDown: proxyDownList,
    targetCompleted: targetCompletedList,
    bannedBots: bannedBotsList
  });
}

io.on('connection', (socket) => {
  broadcastState();

  socket.on('start_bots_fleet', (payload) => {
    const { botList, proxyList } = payload;
    runtimeProxies = proxyList || [];
    
    logMsg(`Launching fleet of ${botList.length} bots...`, 'info');
    botList.forEach((b, index) => {
      if (!activeBots.has(b.username)) {
        createBotInstance(b.username, b.password, index);
      }
    });
  });

  socket.on('stop_all_bots', () => {
    logMsg(`Stopping all active bots...`, 'warn');
    activeBots.forEach((botData) => {
      if (botData.instance) botData.instance.quit();
    });
    activeBots.clear();
    broadcastState();
  });

  socket.on('stop_bot', (username) => {
    const botData = activeBots.get(username);
    if (botData && botData.instance) {
      botData.instance.quit();
      activeBots.delete(username);
      broadcastState();
    }
  });

  socket.on('add_staff', (staffName) => {
    if (staffName && !staffMembers.includes(staffName)) {
      staffMembers.push(staffName);
      broadcastState();
    }
  });

  socket.on('remove_staff', (staffName) => {
    staffMembers = staffMembers.filter(s => s !== staffName);
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`GamsterMan server running on port ${PORT}`);
});
