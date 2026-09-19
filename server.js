const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const si = require('systeminformation');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

// In-Memory Database (Replace with MongoDB/MySQL for production)
const users = {
    "Admin": { password: "Admin@2011", role: "admin", approved: true }
};
const bots = {}; // { botId: { instance: mineflayer, config: {}, fails: 0 } }
const userBots = {}; // { username: [botId1, botId2] }
const staffLists = {}; // { username: ['Henriks9'] }

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('register', ({ username, password }) => {
        if (users[username]) return socket.emit('auth_error', 'User exists.');
        users[username] = { password, role: 'normal', approved: false };
        socket.emit('registration_success', username);
    });

    socket.on('login', ({ username, password }) => {
        const user = users[username];
        if (!user || user.password !== password) return socket.emit('auth_error', 'Invalid credentials.');
        if (!user.approved) return socket.emit('auth_error', `Pending. Message @_ryxk on Discord:\n"Requesting For Approval of My Account @${username}"`);
        
        currentUser = user;
        currentUser.username = username;
        if (!userBots[username]) userBots[username] = [];
        
        socket.emit('login_success', { username, role: user.role });
        
        if (user.role === 'admin') {
            startSystemTelemetry(socket);
            socket.emit('admin_users_list', users);
        }
    });

    // Deploy Bot
    socket.on('deploy_bot', (config) => {
        if (!currentUser) return;
        const botId = uuidv4();
        const port = config.port || 25565;
        
        const botOptions = {
            host: config.ip,
            port: parseInt(port),
            username: config.accountType === 'cookie' ? config.cookieEmail : config.username,
            auth: config.accountType === 'cookie' ? 'microsoft' : 'offline',
            version: false // Auto-detect
        };

        if (config.password) botOptions.password = config.password;

        // Mocking proxy logic - in production use 'mineflayer-socks'
        let bot;
        try {
            bot = mineflayer.createBot(botOptions);
            bot.loadPlugin(pathfinder);
        } catch (err) {
            return socket.emit('bot_log', { id: botId, msg: 'System Warning: Deployment Failed' });
        }

        bots[botId] = { instance: bot, config, fails: 0, owner: currentUser.username, startTime: Date.now() };
        userBots[currentUser.username].push(botId);

        bot.on('spawn', () => {
            bots[botId].fails = 0;
            socket.emit('bot_log', { id: botId, msg: `System Warning: Connected to ${config.ip}` });

            // Timer logic
            if (config.timer) {
                setTimeout(() => {
                    if (bots[botId]) {
                        bot.quit();
                        socket.emit('bot_success_afk', { ...config, uptime: Date.now() - bots[botId].startTime });
                    }
                }, config.timer * 60000);
            }

            // Movement Logic (Pro/Admin only)
            if (config.movement && (currentUser.role === 'admin' || currentUser.role === 'pro')) {
                setInterval(() => {
                    const actions = ['forward', 'back', 'left', 'right', 'jump', 'sprint'];
                    const action = actions[Math.floor(Math.random() * actions.length)];
                    bot.setControlState(action, true);
                    bot.look(Math.random() * Math.PI * 2, 0); // Human-like rotation
                    setTimeout(() => bot.setControlState(action, false), 1000);
                }, 300000 + Math.random() * 300000); // 5-10 minutes
            }
        });

        // Staff Evasion (Pro/Admin only)
        bot.on('playerJoined', (player) => {
            if (config.staffEvasion && (currentUser.role === 'admin' || currentUser.role === 'pro')) {
                const myStaff = staffLists[currentUser.username] || ['Henriks9']; 
                if (myStaff.includes(player.username)) {
                    socket.emit('bot_log', { id: botId, msg: `System Warning: Staff ${player.username} Joined. Evasion triggered. Disconnecting for 15s.` });
                    bot.quit();
                    // Reconnection logic would trigger here
                }
            }
        });

        bot.on('end', () => {
            if (bots[botId]) {
                bots[botId].fails += 1;
                socket.emit('bot_log', { id: botId, msg: 'System Warning: Disconnected' });
                if (bots[botId].fails >= 5) {
                    socket.emit('proxy_down', { id: botId, ...config, uptime: Date.now() - bots[botId].startTime });
                } else {
                    socket.emit('bot_log', { id: botId, msg: 'System Warning: Reconnecting in 15 seconds...' });
                    // Reconnect logic stub
                }
            }
        });
    });

    // Global Chat Command for all owned bots
    socket.on('global_chat', (msg) => {
        if (!currentUser) return;
        const myBots = userBots[currentUser.username] || [];
        myBots.forEach(id => {
            if (bots[id] && bots[id].instance) {
                bots[id].instance.chat(msg);
            }
        });
    });

    // Admin Controls
    socket.on('admin_update_user', ({ targetUser, role, approved }) => {
        if (currentUser?.role === 'admin' && users[targetUser]) {
            users[targetUser].role = role;
            users[targetUser].approved = approved;
            socket.emit('admin_users_list', users);
        }
    });
});

// Admin System Telemetry
function startSystemTelemetry(socket) {
    setInterval(async () => {
        const cpu = await si.currentLoad();
        const mem = await si.mem();
        const disk = await si.fsSize();
        socket.emit('sys_stats', {
            cpu: cpu.currentLoad.toFixed(2),
            ram: ((mem.active / mem.total) * 100).toFixed(2),
            disk: disk[0] ? disk[0].use.toFixed(2) : 0
        });
    }, 5000);
}

server.listen(3000, () => console.log('Sleepy Client Backend running on port 3000'));
                                       
