const express = require('express');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const axios = require('axios');
const https = require('https');
const { createCanvas } = require('canvas');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
const activeBots = new Map();

let STAFF_LIST = new Set([
  'henriks9', 'seeken', 'akyss', 'lupu_xx_x', 'ionutz547', 'andreibeni',
  'snaccks', 'gr_veteran', 'osmiumredox', 'bombita_01', 'ld007', 'space_turtle9',
  'urswu', 'gamsterevent', 'xspeed10', 'fredy_9', 'weepinangels', 'h2mzh',
  'doritostar', 'athul', 'godkissed', 'synchitss', '_pixelwarrioryt_',
  'karlthhkiller3', 'pintux', 'wost_ali', 'robi5937', 'mihaaiiii', 'megasus',
  'theashz', 'tini_alina', 'gamster', 'itsb2_', 'officialmex', 'nayskutzu',
  'maria_int', '_shadowxd'
]);

function formatUptime(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((ms % (1000 * 60)) / 1000);
  return `${hours}h ${minutes}m ${seconds}s`;
}

function parseProxy(proxyStr) {
  if (!proxyStr || !proxyStr.trim()) return null;
  let clean = proxyStr.trim().replace('socks5://', '');
  const parts = clean.split(':');
  if (parts.length >= 4) {
    return { host: parts[0], port: parseInt(parts[1], 10), userId: parts[2], password: parts.slice(3).join(':') };
  } else if (parts.length === 2) {
    return { host: parts[0], port: parseInt(parts[1], 10) };
  }
  return null;
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
        try { clientInstance.emit('error', new Error(`SOCKS5 Error: ${err.message}`)); } catch (e) {}
      });
  };
}

// --- API ENDPOINTS ---

app.post('/api/spawn', (req, res) => {
  const { server, usernames, password, proxy } = req.body;
  const hostPort = server.split(':');
  const host = hostPort[0];
  const port = parseInt(hostPort[1]) || 25565;
  const userList = usernames.split(',').map(u => u.trim());

  userList.forEach((username, index) => {
    setTimeout(() => {
      let session = activeBots.get(username);
      if (!session) {
        session = {
          username, password, proxyInput: proxy, host, port,
          status: 'Connecting...', chatLogs: [], accumulatedTime: 0,
          lastConnectTime: null, isOnline: false, isConnecting: false,
          spawnIndex: index, bot: null
        };
        activeBots.set(username, session);
      }
      connectBot(session);
    }, index * 15000);
  });

  res.json({ status: 'ok' });
});

app.post('/api/setproxy', (req, res) => {
  const { username, proxy } = req.body;
  const session = activeBots.get(username);
  if (session) {
    session.proxyInput = proxy;
    session.status = 'Proxy Updated. Reconnecting...';
    connectBot(session);
    return res.json({ status: 'ok' });
  }
  res.status(404).json({ error: 'Bot not found' });
});

app.post('/api/checkproxy', async (req, res) => {
  const p = parseProxy(req.body.proxy);
  if (!p) return res.status(400).json({ error: 'Invalid proxy format' });

  const ips = [];
  for (let i = 0; i < 5; i++) {
    try {
      const conn = await SocksClient.createConnection({
        proxy: { host: p.host, port: p.port, type: 5, userId: p.userId, password: p.password },
        command: 'connect',
        destination: { host: 'api.ipify.org', port: 443 },
        timeout: 6000
      });

      const response = await axios.get('https://api.ipify.org', {
        httpsAgent: new https.Agent({ socket: conn.socket, keepAlive: false }),
        timeout: 5000
      });
      ips.push(response.data.trim());
    } catch (e) {
      ips.push(`Error (${e.message})`);
    }
  }

  const validIps = ips.filter(ip => !ip.startsWith('Error'));
  const isStatic = validIps.length > 0 && validIps.every(val => val === validIps[0]);
  res.json({ result: isStatic ? 'STATIC PROXY' : 'ROTATING PROXY', ips });
});

app.post('/api/move', (req, res) => {
  const { username, x, y, z } = req.body;
  const session = activeBots.get(username);
  if (!session || !session.isOnline || !session.bot) return res.status(400).json({ error: 'Bot offline' });

  const bot = session.bot;
  const moveInterval = setInterval(() => {
    if (!session.isOnline || !bot || !bot.entity) {
      clearInterval(moveInterval);
      return;
    }
    const current = bot.entity.position;
    const dist = Math.hypot(x - current.x, z - current.z);

    if (dist < 1.2) {
      clearInterval(moveInterval);
      bot.clearControlStates();
      return;
    }

    const dx = x - current.x;
    const dz = z - current.z;
    bot.look(Math.atan2(-dx, dz), 0, false);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', true);
  }, 300);

  res.json({ status: 'moving' });
});

app.post('/api/staff', (req, res) => {
  const { action, username } = req.body;
  if (action === 'add') STAFF_LIST.add(username.toLowerCase());
  if (action === 'remove') STAFF_LIST.delete(username.toLowerCase());
  res.json({ status: 'ok' });
});

app.post('/api/chat', (req, res) => {
  const { target, message } = req.body;
  if (target === 'all') {
    activeBots.forEach(s => s.isOnline && s.bot && s.bot.chat(message));
  } else {
    const s = activeBots.get(target);
    if (s && s.isOnline && s.bot) s.bot.chat(message);
  }
  res.json({ status: 'ok' });
});

app.post('/api/stop', (req, res) => {
  const { username } = req.body;
  if (username === 'all') {
    activeBots.forEach(s => s.bot && s.bot.quit());
    activeBots.clear();
  } else {
    const s = activeBots.get(username);
    if (s && s.bot) s.bot.quit();
    activeBots.delete(username);
  }
  res.json({ status: 'ok' });
});

app.get('/api/status', (req, res) => {
  const list = [];
  activeBots.forEach((session, name) => {
    let uptimeMs = session.accumulatedTime;
    if (session.isOnline && session.lastConnectTime) uptimeMs += (Date.now() - session.lastConnectTime);

    let coords = null;
    if (session.isOnline && session.bot?.entity?.position) {
      const pos = session.bot.entity.position;
      coords = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
    }

    list.push({
      username: name,
      status: session.status,
      isOnline: session.isOnline,
      uptime: formatUptime(uptimeMs),
      ping: session.isOnline && session.bot ? session.bot.player?.ping || 0 : 0,
      coordinates: coords
    });
  });
  res.json({ count: list.length, bots: list });
});

// GET INVENTORY CANVAS FOR A SPECIFIC BOT
app.get('/api/inventory/:username', (req, res) => {
  const session = activeBots.get(req.params.username);
  if (!session || !session.isOnline || !session.bot) return res.status(404).send('Bot Offline');

  const items = session.bot.inventory?.items() || [];
  const canvas = createCanvas(450, 250);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, 450, 250);
  ctx.font = '10px Arial';

  for (let i = 0; i < 36; i++) {
    const row = Math.floor(i / 9);
    const col = i % 9;
    const x = 15 + (col * 46);
    const y = 15 + (row * 46);

    ctx.strokeStyle = '#555555';
    ctx.strokeRect(x, y, 40, 40);

    // Draw Slot Index
    ctx.fillStyle = '#777777';
    ctx.fillText(`${i}`, x + 2, y + 10);

    const item = items.find(it => it.slot === i);
    if (item && item.name) {
      ctx.fillStyle = '#00ffcc';
      ctx.fillText(`${item.name.substring(0, 6)}`, x + 2, y + 24);
      ctx.fillStyle = '#ffff00';
      ctx.fillText(`x${item.count}`, x + 22, y + 36);
    }
  }

  res.setHeader('Content-Type', 'image/png');
  res.send(canvas.toBuffer());
});

// CLICK INVENTORY SLOT (LEFT / RIGHT)
app.post('/api/inventory/click', async (req, res) => {
  const { username, slot, mouseButton } = req.body;
  const session = activeBots.get(username);
  if (!session || !session.isOnline || !session.bot) return res.status(400).json({ error: 'Bot offline' });

  try {
    // mouseButton: 0 = Left Click, 1 = Right Click
    await session.bot.clickWindow(slot, mouseButton, 0);
    res.json({ status: 'clicked' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function connectBot(session) {
  if (session.isOnline) return;
  session.status = 'Connecting...';
  const proxyConfig = parseProxy(session.proxyInput);

  const botOpts = {
    host: session.host,
    port: session.port,
    username: session.username,
    version: '1.8.9',
    brand: 'Lunar Client'
  };

  if (proxyConfig) botOpts.connect = createSocksConnect(proxyConfig, session.host, session.port);

  const bot = mineflayer.createBot(botOpts);
  session.bot = bot;

  bot.once('spawn', () => {
    session.isOnline = true;
    session.status = 'Online in Server';
    session.lastConnectTime = Date.now();

    if (session.password) {
      setTimeout(() => bot.chat(`/register ${session.password} ${session.password}`), 1500);
      setTimeout(() => bot.chat(`/login ${session.password}`), 3500);
    }
  });

  bot.on('end', () => {
    session.isOnline = false;
    session.status = 'Disconnected';
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard active on port ${PORT}`);
});
      
