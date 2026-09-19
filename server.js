const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const socks = require('socks');
const path = require('path');

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

const TARGET_AFK_MS = (20 * 3600 + 10 * 60) * 1000; // 20 hours 10 minutes
const MAX_DROPS = 5;

let runtimeProxies = [];
let staffMembers = ['Henriks9', 'Admin', 'StaffMember'];
let activeBots = new Map();

// Saved Bot Database for preserving password & accumulated AFK uptime across restarts/proxy switches
let savedBotStates = new Map(); // username -> { password, accruedAfkMs }

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

function createBotInstance(username, password, assignedProxy) {
  // Store or load credentials & saved uptime
  let savedState = savedBotStates.get(username);
  if (!savedState) {
    savedState = { password, accruedAfkMs: 0 };
    savedBotStates.set(username, savedState);
  }

  const botOptions = {
    host: 'gamester.org',
    port: 25565,
    username: username,
    version: '1.8.9'
  };

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
          logMsg(`Proxy connection failed for ${username}: ${err.message}`, 'error');
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
    password: savedState.password,
    proxy: assignedProxy || 'Direct / None',
    ping: 40,
    dropCount: 0,
    sessionStartTime: null,
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
    logMsg(`Bot ${username} connected to server.`, 'success');
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
      const currentSessionMs = Date.now() - botData.sessionStartTime;
      const totalUptimeMs = savedState.accruedAfkMs + currentSessionMs;

      if (totalUptimeMs >= TARGET_AFK_MS) {
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
    saveBotUptime(username);
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
    botData.sessionStartTime = Date.now();
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
    logMsg(`STAFF ALERT: ${foundStaff} detected near ${username}! Evading.`, 'error');
    saveBotUptime(username);
    const botData = activeBots.get(username);
    if (botData && botData.instance) {
      botData.instance.quit();
      activeBots.delete(username);
      broadcastState();
    }
  }
}

function saveBotUptime(username) {
  const botData = activeBots.get(username);
  const savedState = savedBotStates.get(username);
  if (botData && savedState && botData.isLoggedIn && botData.sessionStartTime) {
    const sessionDuration = Date.now() - botData.sessionStartTime;
    savedState.accruedAfkMs += sessionDuration;
    botData.sessionStartTime = null;
    botData.isLoggedIn = false;
  }
}

function getTotalBotUptimeMs(username) {
  const savedState = savedBotStates.get(username);
  const accrued = savedState ? savedState.accruedAfkMs : 0;
  const botData = activeBots.get(username);
  if (botData && botData.isLoggedIn && botData.sessionStartTime) {
    return accrued + (Date.now() - botData.sessionStartTime);
  }
  return accrued;
}

function handleBotDrop(username) {
  saveBotUptime(username);
  const botData = activeBots.get(username);
  if (!botData) return;

  botData.dropCount += 1;
  logMsg(`Bot ${username} drops: ${botData.dropCount}/${MAX_DROPS}`, 'warn');

  if (botData.dropCount >= MAX_DROPS) {
    const savedState = savedBotStates.get(username);
    logMsg(`Bot ${username} reached drop limit. Moving to Proxy Down.`, 'error');
    
    // Add to Proxy Down List with Password & Preserved Uptime
    proxyDownList = proxyDownList.filter(p => p.username !== username);
    proxyDownList.push({
      username: botData.username,
      password: savedState ? savedState.password : botData.password,
      proxy: botData.proxy,
      savedUptimeMs: savedState ? savedState.accruedAfkMs : 0,
      reason: `Exceeded ${MAX_DROPS} connection drops`,
      timestamp: new Date().toLocaleTimeString()
    });

    if (botData.instance) botData.instance.quit();
    activeBots.delete(username);
  }
  broadcastState();
}

function handleBannedBot(username, reason) {
  saveBotUptime(username);
  const botData = activeBots.get(username);
  const savedState = savedBotStates.get(username);
  if (botData) {
    bannedBotsList = bannedBotsList.filter(b => b.username !== username);
    bannedBotsList.push({
      username: botData.username,
      password: savedState ? savedState.password : botData.password,
      proxy: botData.proxy,
      savedUptimeMs: savedState ? savedState.accruedAfkMs : 0,
      reason,
      timestamp: new Date().toLocaleTimeString()
    });
    if (botData.instance) botData.instance.quit();
    activeBots.delete(username);
  }
  broadcastState();
}

function completeTargetAfk(username) {
  saveBotUptime(username);
  const botData = activeBots.get(username);
  const savedState = savedBotStates.get(username);
  if (botData) {
    logMsg(`TARGET ACHIEVED: Bot ${username} completed 20h 10m AFK!`, 'success');
    targetCompletedList = targetCompletedList.filter(c => c.username !== username);
    targetCompletedList.push({
      username: botData.username,
      password: savedState ? savedState.password : botData.password,
      proxy: botData.proxy,
      savedUptimeMs: savedState ? savedState.accruedAfkMs : TARGET_AFK_MS,
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
    password: b.password,
    proxy: b.proxy,
    ping: b.ping,
    dropCount: b.dropCount,
    afkDurationMs: getTotalBotUptimeMs(b.username),
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

    botList.forEach((b, index) => {
      const proxy = getProxyForBotIndex(index);
      if (!activeBots.has(b.username)) {
        createBotInstance(b.username, b.password, proxy);
      }
    });
  });

  // Revive up to 4 Bots with 1 new Proxy, keeping preserved uptime!
  socket.on('revive_bots', (payload) => {
    const { usernames, newProxy } = payload;
    logMsg(`Reviving ${usernames.length} bot(s) using new proxy: ${newProxy}`, 'info');

    usernames.forEach(uname => {
      // Remove from Proxy Down list if present
      proxyDownList = proxyDownList.filter(p => p.username !== uname);

      // Fetch saved credentials
      const savedState = savedBotStates.get(uname);
      const password = savedState ? savedState.password : 'unknown';

      // Disconnect if running
      if (activeBots.has(uname)) {
        const bData = activeBots.get(uname);
        if (bData.instance) bData.instance.quit();
        activeBots.delete(uname);
      }

      // Re-launch with new proxy while keeping accrued AFK uptime
      createBotInstance(uname, password, newProxy);
    });

    broadcastState();
  });

  socket.on('stop_all_bots', () => {
    activeBots.forEach((botData, uname) => {
      saveBotUptime(uname);
      if (botData.instance) botData.instance.quit();
    });
    activeBots.clear();
    broadcastState();
  });

  socket.on('stop_bot', (username) => {
    saveBotUptime(username);
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
             
