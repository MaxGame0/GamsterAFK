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
    'admin': { password: 'admin', role: 'Admin', status: 'Approved' } // Default admin
};
const proxies = []; // Array of { host, port, type: 5 }
const activeBots = new Map(); // botId -> { bot, config, owner, retries }
const staffList = ['Henriks9', 'AdminSteve']; // Example staff evasion list

// --- System Telemetry ---
setInterval(async () => {
    try {
        const cpu = await si.currentLoad();
        const mem = await si.mem();
        const disk = await si.fsSize();
        
        const stats = {
            cpu: cpu.currentLoad.toFixed(2),
            ram: ((mem.active / mem.total) * 100).toFixed(2),
            disk: disk.length > 0 ? disk[0].use.toFixed(2) : 0
        };
        io.emit('sys_stats', stats);
    } catch (err) {
        console.error("Telemetry Error:", err);
    }
}, 5000);

// --- Socket.io Logic ---
io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('register', (data) => {
        if (users[data.username]) {
            return socket.emit('auth_error', 'User already exists.');
        }
        users[data.username] = { password: data.password, role: 'Normal', status: 'Pending' };
        socket.emit('auth_success', { message: 'Registration pending. Please message a Discord admin for approval.', status: 'Pending' });
    });

    socket.on('login', (data) => {
        const user = users[data.username];
        if (!user || user.password !== data.password) {
            return socket.emit('auth_error', 'Invalid credentials.');
        }
        if (user.status !== 'Approved') {
            return socket.emit('auth_error', 'Account pending admin approval.');
        }
        currentUser = { username: data.username, role: user.role };
        socket.emit('login_success', currentUser);
    });

    // Admin Proxy Management
    socket.on('add_proxy', (data) => {
        if (!currentUser || currentUser.role !== 'Admin') return;
        proxies.push({ host: data.host, port: parseInt(data.port), type: 5 });
        socket.emit('bot_log', { msg: `Added proxy ${data.host}:${data.port}` });
    });

    // Deploy Bot
    socket.on('deploy_bot', (config) => {
        if (!currentUser) return;
        config.owner = currentUser.username;
        config.role = currentUser.role;
        config.botId = uuidv4();
        
        deployMineflayer(config, socket);
    });

    // Global Chat Action
    socket.on('global_chat', (message) => {
        if (!currentUser) return;
        activeBots.forEach((botData) => {
            if (botData.owner === currentUser.username && botData.bot) {
                botData.bot.chat(message);
                socket.emit('bot_log', { msg: `[Global] Sent message from ${botData.bot.username}` });
            }
        });
    });

    socket.on('disconnect', () => {
        // We do not disconnect bots on socket disconnect for 24/7 AFK functionality
    });
});

// --- Mineflayer Deployment & Logic ---
function deployMineflayer(config, socket, isReconnect = false) {
    if (!isReconnect) {
        activeBots.set(config.botId, { config, owner: config.owner, retries: 0 });
    }
    
    const botData = activeBots.get(config.botId);
    if (botData.retries >= 5) {
        socket.emit('proxy_down', { botId: config.botId, host: config.host });
        return;
    }

    const botOptions = {
        host: config.host,
        port: config.port || 25565,
        username: config.auth === 'microsoft' ? undefined : config.username,
        auth: config.auth,
        version: config.version || false,
    };

    // Apply SOCKS5 Proxy if available
    if (proxies.length > 0) {
        const proxy = proxies[Math.floor(Math.random() * proxies.length)];
        botOptions.connect = client => {
            SocksClient.createConnection({
                proxy: { ipaddress: proxy.host, port: proxy.port, type: proxy.type },
                command: 'connect',
                destination: { host: botOptions.host, port: botOptions.port }
            }, (err, info) => {
                if (err) return client.emit('error', err);
                client.setSocket(info.socket);
                client.emit('connect');
            });
        };
        socket.emit('bot_log', { msg: `Routing via proxy: ${proxy.host}` });
    }

    const bot = mineflayer.createBot(botOptions);
    bot.loadPlugin(pathfinder);
    botData.bot = bot;

    bot.once('spawn', () => {
        socket.emit('bot_log', { msg: `Bot ${bot.username} spawned successfully.` });
        botData.retries = 0; // Reset retries on successful connection

        // Handle Cracked Server Auth
        if (config.auth === 'offline' && config.password) {
            setTimeout(() => {
                bot.chat(`/register ${config.password} ${config.password}`);
                socket.emit('bot_log', { msg: `[Auth] Sent register command.` });
                setTimeout(() => {
                    bot.chat(`/login ${config.password}`);
                    socket.emit('bot_log', { msg: `[Auth] Sent login command.` });
                }, 1000);
            }, 1500); // 1.5s delay to avoid spam kick
        }

        // Pro/Admin Anti-AFK
        if (config.role === 'Pro' || config.role === 'Admin') {
            botData.afkInterval = setInterval(() => {
                bot.setControlState('jump', true);
                bot.look(Math.random() * Math.PI * 2, 0);
                setTimeout(() => bot.setControlState('jump', false), 500);
            }, 10000 + Math.random() * 20000);
        }
    });

    // Pro/Admin Staff Evasion
    if (config.role === 'Pro' || config.role === 'Admin') {
        bot.on('playerJoined', (player) => {
            if (staffList.includes(player.username)) {
                socket.emit('bot_log', { msg: `[Evasion] Staff ${player.username} joined. Evading!` });
                bot.quit('Staff evasion triggered');
            }
        });
    }

    bot.on('error', (err) => {
        socket.emit('bot_log', { msg: `Error: ${err.message}` });
    });

    bot.on('end', (reason) => {
        socket.emit('bot_log', { msg: `Bot disconnected: ${reason}. Reconnecting in 15s...` });
        clearInterval(botData.afkInterval);
        
        botData.retries++;
        setTimeout(() => {
            deployMineflayer(config, socket, true);
        }, 15000); // 15 seconds wait
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
          
