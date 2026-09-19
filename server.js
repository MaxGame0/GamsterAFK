const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const si = require('systeminformation');
const { v4: uuidv4 } = require('uuid');
const { SocksClient } = require('socks');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// --- In-Memory Database ---
const users = {
    'admin': { password: 'admin', role: 'Admin', status: 'Approved' }
};
const proxies = []; 
const activeBots = new Map(); 
const staffList = ['Henriks9', 'AdminSteve', 'ServerMod'];

// --- System Telemetry Broadcast ---
setInterval(async () => {
    try {
        const cpu = await si.currentLoad();
        const mem = await si.mem();
        const disk = await si.fsSize();
        
        const stats = {
            cpu: cpu.currentLoad.toFixed(1),
            ram: ((mem.active / mem.total) * 100).toFixed(1),
            disk: disk.length > 0 ? disk[0].use.toFixed(1) : 0
        };
        io.emit('sys_stats', stats);
    } catch (err) {
        console.error("Telemetry Error:", err);
    }
}, 5000);

// --- Socket.io Real-Time Engine ---
io.on('connection', (socket) => {
    let currentUser = null;

    socket.emit('proxy_list_update', proxies);

    socket.on('register', (data) => {
        if (!data || !data.username || !data.password) {
            return socket.emit('auth_error', 'Username and password are required.');
        }
        const username = data.username.trim();
        const password = data.password.trim();

        if (users[username]) {
            return socket.emit('auth_error', 'Username already exists.');
        }
        
        users[username] = { password, role: 'Normal', status: 'Pending' };
        socket.emit('auth_success', { message: 'Registration successful! Status: Pending. Log in as admin/admin to approve it.' });
        
        // Broadcast update to all admins online
        io.emit('admin_data_refresh', getUsersAndProxies());
    });

    socket.on('login', (data) => {
        if (!data || !data.username || !data.password) {
            return socket.emit('auth_error', 'Username and password are required.');
        }
        const username = data.username.trim();
        const password = data.password.trim();

        const user = users[username];
        if (!user || user.password !== password) {
            return socket.emit('auth_error', 'Invalid username or password.');
        }
        if (user.status !== 'Approved') {
            return socket.emit('auth_error', 'Account is pending admin approval.');
        }
        
        currentUser = { username, role: user.role };
        socket.emit('login_success', currentUser);
        socket.emit('proxy_list_update', proxies);
    });

    // Admin: Manage Proxies
    socket.on('add_proxy', (data) => {
        if (!currentUser || currentUser.role !== 'Admin') return;
        if (!data || !data.host || !data.port) return;
        const newProxy = { id: uuidv4(), host: data.host.trim(), port: parseInt(data.port), type: 5 };
        proxies.push(newProxy);
        io.emit('proxy_list_update', proxies);
        socket.emit('bot_log', { msg: `[Proxy Admin] Added proxy node: ${data.host}:${data.port}` });
        io.emit('admin_data_refresh', getUsersAndProxies());
    });

    socket.on('remove_proxy', (proxyId) => {
        if (!currentUser || currentUser.role !== 'Admin') return;
        const index = proxies.findIndex(p => p.id === proxyId);
        if (index !== -1) {
            proxies.splice(index, 1);
            io.emit('proxy_list_update', proxies);
            socket.emit('bot_log', { msg: `[Proxy Admin] Removed proxy ID: ${proxyId}` });
            io.emit('admin_data_refresh', getUsersAndProxies());
        }
    });

    // Admin: Approve Users
    socket.on('approve_user', (username) => {
        if (!currentUser || currentUser.role !== 'Admin') return;
        if (users[username]) {
            users[username].status = 'Approved';
            socket.emit('bot_log', { msg: `[Admin] Approved user account: ${username}` });
            io.emit('admin_data_refresh', getUsersAndProxies());
        }
    });

    socket.on('fetch_admin_data', () => {
        if (!currentUser || currentUser.role !== 'Admin') return;
        socket.emit('admin_data_refresh', getUsersAndProxies());
    });

    // Deploy Bot Instance
    socket.on('deploy_bot', (config) => {
        if (!currentUser) return;
        config.owner = currentUser.username;
        config.role = currentUser.role;
        config.botId = uuidv4();
        
        deployMineflayer(config, socket);
    });

    // Global Chat Action
    socket.on('global_chat', (message) => {
        if (!currentUser || !message) return;
        activeBots.forEach((botData) => {
            if (botData.owner === currentUser.username && botData.bot) {
                try {
                    botData.bot.chat(message);
                    socket.emit('bot_log', { msg: `[Global Chat Sent from ${botData.bot.username}]: ${message}` });
                } catch(e) {}
            }
        });
    });

    socket.on('disconnect', () => {});
});

function getUsersAndProxies() {
    const userList = Object.keys(users).map(username => ({
        username,
        role: users[username].role,
        status: users[username].status
    }));
    return { users: userList, proxies };
}

// --- Mineflayer Deployment Engine ---
function deployMineflayer(config, socket, isReconnect = false) {
    if (!isReconnect) {
        activeBots.set(config.botId, { config, owner: config.owner, retries: 0 });
    }
    
    const botData = activeBots.get(config.botId);
    if (!botData) return;

    if (botData.retries >= 5) {
        socket.emit('proxy_down', { botId: config.botId, host: config.host });
        socket.emit('bot_log', { msg: `[Fatal] Bot ${config.botId} failed 5 consecutive reconnect attempts. Halting.` });
        return;
    }

    const botOptions = {
        host: config.host,
        port: config.port || 25565,
        username: config.auth === 'microsoft' ? undefined : config.username,
        auth: config.auth,
        version: config.version || false,
    };

    if (config.proxyId && proxies.length > 0) {
        const selectedProxy = proxies.find(p => p.id === config.proxyId);
        if (selectedProxy) {
            botOptions.connect = client => {
                SocksClient.createConnection({
                    proxy: { ipaddress: selectedProxy.host, port: selectedProxy.port, type: selectedProxy.type },
                    command: 'connect',
                    destination: { host: botOptions.host, port: botOptions.port }
                }, (err, info) => {
                    if (err) {
                        socket.emit('bot_log', { msg: `[Proxy Error] SOCKS5 Connection failed: ${err.message}` });
                        return client.emit('error', err);
                    }
                    client.setSocket(info.socket);
                    client.emit('connect');
                });
            };
            socket.emit('bot_log', { msg: `[Network] Tunneling connection through SOCKS5 Proxy -> ${selectedProxy.host}:${selectedProxy.port}` });
        }
    }

    const bot = mineflayer.createBot(botOptions);
    bot.loadPlugin(pathfinder);
    botData.bot = bot;

    bot.once('spawn', () => {
        socket.emit('bot_log', { msg: `[Success] Bot '${bot.username}' has successfully spawned into ${config.host}!` });
        socket.emit('successful_afk_add', { botId: config.botId, username: bot.username, host: config.host });
        botData.retries = 0;

        if (config.auth === 'offline' && config.password) {
            setTimeout(() => {
                try {
                    bot.chat(`/register ${config.password} ${config.password}`);
                    socket.emit('bot_log', { msg: `[Auth] Dispatched register command for ${bot.username}` });
                    setTimeout(() => {
                        bot.chat(`/login ${config.password}`);
                        socket.emit('bot_log', { msg: `[Auth] Dispatched login authentication for ${bot.username}` });
                    }, 1200);
                } catch(e) {}
            }, 1800);
        }

        if (config.role === 'Pro' || config.role === 'Admin') {
            botData.afkInterval = setInterval(() => {
                try {
                    bot.setControlState('jump', true);
                    bot.look(Math.random() * Math.PI * 2, (Math.random() * 0.5) - 0.25);
                    setTimeout(() => bot.setControlState('jump', false), 400);
                } catch(e) {}
            }, 12000 + Math.random() * 15000);
        }
    });

    if (config.role === 'Pro' || config.role === 'Admin') {
        bot.on('playerJoined', (player) => {
            if (staffList.includes(player.username)) {
                socket.emit('bot_log', { msg: `[Security Evasion] Staff member '${player.username}' detected! Disconnecting bot for 15s.` });
                try { bot.quit('Staff inspection evasion'); } catch(e) {}
            }
        });
    }

    bot.on('error', (err) => {
        socket.emit('bot_log', { msg: `[Bot Error] ${err.message}` });
    });

    bot.on('end', (reason) => {
        socket.emit('bot_log', { msg: `[Disconnected] Reason: '${reason}'. Reconnecting in 15s... (Attempt ${botData.retries + 1}/5)` });
        if (botData.afkInterval) clearInterval(botData.afkInterval);
        
        botData.retries++;
        setTimeout(() => {
            deployMineflayer(config, socket, true);
        }, 15000);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`NexBot Enterprise backend running on port ${PORT}`);
});
                
