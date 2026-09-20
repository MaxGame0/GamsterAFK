const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { SocksClient } = require('socks');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const si = require('systeminformation');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// Application State
const state = {
    activeBots: {},
    proxyDown: {},
    success: [],
    banned: []
};

const SUCCESS_UPTIME = (20 * 60 * 60 * 1000) + (60 * 1000); // 20 hours 1 min

// Helper: Parse proxy string (ip:port)
function parseProxy(proxyStr) {
    if (!proxyStr) return null;
    const [ip, port] = proxyStr.split(':');
    return { ip, port: parseInt(port) };
}

// Helper: Proxy Checker
async function checkProxy(proxyStr) {
    const proxy = parseProxy(proxyStr);
    if (!proxy) return { error: "Invalid proxy format" };
    
    const agent = new HttpsProxyAgent(`http://${proxy.ip}:${proxy.port}`);
    let ips = [];
    
    try {
        for (let i = 0; i < 5; i++) {
            const res = await axios.get('https://api.ipify.org?format=json', { httpsAgent: agent, timeout: 5000 });
            ips.push(res.data.ip);
        }
        const uniqueIps = new Set(ips);
        return { 
            alive: true, 
            type: uniqueIps.size === 1 ? 'Sticky' : 'Rotating',
            endpoints: Array.from(uniqueIps)
        };
    } catch (e) {
        return { alive: false };
    }
}

// Bot Spawner Function
function spawnBot(config) {
    const { id, username, password, auth, proxyStr, savedUptime = 0 } = config;
    
    let botConfig = {
        host: 'gamester.org',
        port: 25565,
        username: username,
        auth: auth,
        version: '1.8.9'
    };

    // Apply SOCKS5 Proxy if provided
    const proxy = parseProxy(proxyStr);
    if (proxy) {
        botConfig.connect = client => {
            SocksClient.createConnection({
                proxy: { ip: proxy.ip, port: proxy.port, type: 5 },
                command: 'connect',
                destination: { host: 'gamester.org', port: 25565 }
            }).then(info => {
                client.setSocket(info.socket);
                client.emit('connect');
            }).catch(err => {
                client.emit('error', err);
            });
        };
    }

    const bot = mineflayer.createBot(botConfig);
    
    // Bot State tracking
    state.activeBots[id] = {
        id, username, password, auth, proxyStr,
        bot: bot,
        uptime: savedUptime,
        lastStartTime: Date.now(),
        drops: 0,
        status: 'Connecting...',
        afkInterval: null,
        uptimeInterval: null
    };

    const bState = state.activeBots[id];

    bot.on('spawn', () => {
        bState.status = 'Spawned';
        bState.drops = 0;
        bState.lastStartTime = Date.now();
        io.emit('sys_log', `[${username}] Spawned successfully.`);

        // Auto-login for cracked accounts
        if (auth === 'offline' && password) {
            setTimeout(() => {
                bot.chat(`/register ${password}${password}`);
                setTimeout(() => bot.chat(`/login ${password}`), 1000);
            }, 1500);
        }

        // Anti-AFK Movement (Every 5-10 mins)
        bState.afkInterval = setInterval(() => {
            if(!bot.entity) return;
            const actions = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];
            const action = actions[Math.floor(Math.random() * actions.length)];
            bot.setControlState(action, true);
            setTimeout(() => bot.setControlState(action, false), 1000);
            bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * Math.PI);
        }, Math.random() * (600000 - 300000) + 300000);

        // Uptime Checker
        bState.uptimeInterval = setInterval(() => {
            const currentSession = Date.now() - bState.lastStartTime;
            const totalUptime = bState.uptime + currentSession;
            if (totalUptime >= SUCCESS_UPTIME) {
                bState.uptime = totalUptime;
                state.success.push({ username, password, uptime: totalUptime });
                io.emit('sys_log', `[${username}] Reached 20h 1m! Moving to Success.`);
                bot.quit();
                cleanupBot(id, false);
            }
            io.emit('update_bots', getPublicBots());
        }, 5000);
    });

    bot.on('playerJoined', (player) => {
        if (player.username === 'Henriks9') {
            io.emit('sys_log', `[${username}] STAFF DETECTED (Henriks9). Disconnecting for 15s.`);
            bState.status = 'Evading Staff';
            bot.quit();
            cleanupBot(id, true, 15000); // Reconnect in 15s
        }
    });

    bot.on('message', (cm) => {
        const msg = cm.toString();
        // Filter out normal chat, keep system/login messages
        if (msg.includes('ban') || msg.toLowerCase().includes('kicked')) {
            io.emit('sys_log', `[${username}] Ban/Kick message:${msg}`);
            if(msg.includes('ban')) {
                state.banned.push({ username, reason: msg });
                cleanupBot(id, false);
            }
        }
    });

    bot.on('end', async (reason) => {
        io.emit('sys_log', `[${username}] Disconnected:${reason}`);
        if(bState.status !== 'Evading Staff') {
            bState.drops += 1;
            if (bState.drops >= 5) {
                io.emit('sys_log', `[${username}] 5 Drops reached. Checking proxy...`);
                const pCheck = await checkProxy(proxyStr);
                if (!pCheck.alive) {
                    io.emit('sys_log', `[${username}] Proxy dead. Moving to Proxy Down.`);
                    state.proxyDown[id] = { ...bState, bot: null, uptime: bState.uptime + (Date.now() - bState.lastStartTime) };
                    cleanupBot(id, false);
                    return;
                }
            }
            cleanupBot(id, true, 15000); // Normal reconnect in 15s
        }
    });

    bot.on('error', (err) => {
        io.emit('sys_log', `[${username}] Error:${err.message}`);
    });
}

function cleanupBot(id, reconnect = false, delay = 0) {
    const bState = state.activeBots[id];
    if (!bState) return;
    
    clearInterval(bState.afkInterval);
    clearInterval(bState.uptimeInterval);
    
    // Pause uptime
    if(bState.lastStartTime) {
        bState.uptime += (Date.now() - bState.lastStartTime);
        bState.lastStartTime = null;
    }

    if (reconnect) {
        setTimeout(() => {
            if (state.activeBots[id]) {
                io.emit('sys_log', `[${bState.username}] Reconnecting...`);
                spawnBot({ ...bState, savedUptime: bState.uptime });
            }
        }, delay);
    } else {
        delete state.activeBots[id];
    }
    io.emit('update_bots', getPublicBots());
}

function getPublicBots() {
    return Object.values(state.activeBots).map(b => ({
        id: b.id, username: b.username, status: b.status, 
        uptime: b.uptime + (b.lastStartTime ? (Date.now() - bState.lastStartTime) : 0)
    }));
}

// Socket.io Events
io.on('connection', (socket) => {
    socket.emit('update_bots', getPublicBots());
    socket.emit('update_proxy_down', Object.values(state.proxyDown));
    
    // System stats loop
    const sysInterval = setInterval(async () => {
        const cpu = await si.currentLoad();
        const mem = await si.mem();
        socket.emit('sys_stats', { cpu: cpu.currentLoad.toFixed(1), ram: ((mem.active / mem.total) * 100).toFixed(1) });
    }, 5000);

    socket.on('deploy', (data) => {
        const id = uuidv4();
        spawnBot({ id, ...data });
    });

    socket.on('global_command', (cmd) => {
        Object.values(state.activeBots).forEach(b => {
            if(b.bot && b.bot.entity) b.bot.chat(cmd);
        });
        io.emit('sys_log', `[GLOBAL] Executed: ${cmd}`);
    });

    socket.on('check_proxy', async (proxy) => {
        socket.emit('sys_log', `[Proxy Tool] Checking ${proxy}...`);
        const res = await checkProxy(proxy);
        socket.emit('proxy_tool_result', res);
    });

    socket.on('revive_bots', (data) => { // data = { ids: [], newProxy: '' }
        data.ids.forEach(id => {
            const botData = state.proxyDown[id];
            if(botData) {
                botData.proxyStr = data.newProxy;
                spawnBot({ ...botData, savedUptime: botData.uptime });
                delete state.proxyDown[id];
            }
        });
        io.emit('update_proxy_down', Object.values(state.proxyDown));
    });

    socket.on('disconnect', () => clearInterval(sysInterval));
});

server.listen(3000, () => console.log('Sleepy Client listening on port 3000'));
