const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});



// Game constants
const CANVAS_WIDTH = 2000;
const CANVAS_HEIGHT = 2000;
const PLAYER_SPEED = 4;
const PROJECTILE_SPEED = 12;
const SHIP_RADIUS = 20;
const POWERUP_RADIUS = 15;

const MAX_KILLS = 30;
const MATCH_DURATION = 600000; // 10 minutes

let matchTime = MATCH_DURATION;
let gameActive = true;
let teamKills = { blue: 0, red: 0 };
let matchResult = null;

const POWERUP_TYPES = {
    HEALTH: { color: '#00ff00', label: '+' },
    SPEED: { color: '#ffff00', label: '⚡' },
    RAPID: { color: '#ff00ff', label: '>>>' }
};

const players = {};
const projectiles = [];
const powerups = [];
const obstacles = [];

// Generate random obstacles
for (let i = 0; i < 15; i++) {
    obstacles.push({
        x: Math.random() * (CANVAS_WIDTH - 100) + 50,
        y: Math.random() * (CANVAS_HEIGHT - 100) + 50,
        width: Math.random() * 60 + 40,
        height: Math.random() * 60 + 40,
        color: '#333' // Placeholder, client will render fancier
    });
}

app.use(express.static(path.join(__dirname, 'client/dist')));

io.on('connection', (socket) => {
    console.log('a user connected:', socket.id);

    // Wait for player to join
    socket.on('join', (data) => {
        const { name, mode } = data;
        let color, team;

        if (mode === 'team') {
            // Simple team assignment: Alternate or random
            // For now, let's just pick based on even/odd or random
            const isBlue = Math.random() > 0.5;
            team = isBlue ? 'blue' : 'red';
            color = isBlue ? '#00f3ff' : '#ff0055';
        } else {
            team = 'solo';
            color = `hsl(${Math.random() * 360}, 100%, 50%)`;
        }

        // Initialize player
        players[socket.id] = {
            x: Math.random() * CANVAS_WIDTH,
            y: Math.random() * CANVAS_HEIGHT,
            angle: 0,
            color: color,
            id: socket.id,
            score: 0,
            name: name || `OP-${socket.id.substr(0, 4)}`,
            team: team,
            maxHp: 100,
            hp: 100,
            // Effects
            speedMult: 1,
            fireRateMult: 1,
            dashCooldown: 0,
            effects: {}
        };

        // Send current players to the new player
        socket.emit('currentPlayers', players);

        // Broadcast the new player to everyone else
        socket.broadcast.emit('newPlayer', players[socket.id]);

        console.log(`User joined: ${name} (${team})`);
    });

    socket.on('disconnect', () => {
        console.log('user disconnected:', socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });

    socket.on('resetRequest', () => {
        resetGame();
    });


    // Handle Chat
    socket.on('chat', (msg) => {
        const player = players[socket.id];
        if (!player) return;
        // Broadcast to everyone
        io.emit('chatMessage', { id: socket.id, name: player.name, color: player.color, text: msg.substring(0, 100) });
    });

    // Handle player movement
    socket.on('playerInput', (input) => {
        if (!gameActive) return;
        const player = players[socket.id];
        if (!player) return;

        if (input.left) player.angle -= 0.1;
        if (input.right) player.angle += 0.1;

        let speed = PLAYER_SPEED * (player.speedMult || 1);

        if (input.dash && player.dashCooldown <= 0) {
            speed *= 3;
            player.dashCooldown = 20; // 20 frames (~1/3 sec) boost length? No, usually instant burst.
            // Let's implement dash as a velocity boost logic or just high speed for one frame?
            // "Dash" usually implies a burst. Let's make it simple state:
            // Actually, best "dash" is just a jump in position or temporary high speed.
            // Let's go with temporary high speed that decays, or just a state "dashing".

            // To keep it simple: if dashing, moving 3x speed for 10 frames.
            player.dashDuration = 10;
            player.dashCooldown = 60; // 1s cooldown

            io.emit('effect', { type: 'dash', id: socket.id });
        }

        if (player.dashDuration > 0) {
            speed *= 3;
            player.dashDuration--;
        }

        if (player.dashCooldown > 0) player.dashCooldown--;

        // Check obstacle collision
        for (const obs of obstacles) {
            if (player.x + Math.cos(player.angle) * speed > obs.x &&
                player.x + Math.cos(player.angle) * speed < obs.x + obs.width &&
                player.y + Math.sin(player.angle) * speed > obs.y &&
                player.y + Math.sin(player.angle) * speed < obs.y + obs.height) {
                // Simple block
                return;
            }
        }

        if (input.up) {
            player.x += Math.cos(player.angle) * speed;
            player.y += Math.sin(player.angle) * speed;
        }

        // Keep inside world boundaries
        player.x = Math.max(SHIP_RADIUS, Math.min(CANVAS_WIDTH - SHIP_RADIUS, player.x));
        player.y = Math.max(SHIP_RADIUS, Math.min(CANVAS_HEIGHT - SHIP_RADIUS, player.y));
    });

    // Handle shooting
    socket.on('shoot', () => {
        const player = players[socket.id];
        if (!player) return;

        // Rate limiting check could go here if server-side validation is needed
        // For now trusting client keyup for "rapid fire" prevention but adding cooldown would be better

        // Simple cooldown check
        const now = Date.now();
        const fireDelay = 200 / (player.fireRateMult || 1);

        if (player.lastShoot && now - player.lastShoot < fireDelay) return;
        player.lastShoot = now;

        io.emit('effect', { type: 'shoot', id: socket.id });

        projectiles.push({
            x: player.x + Math.cos(player.angle) * SHIP_RADIUS,
            y: player.y + Math.sin(player.angle) * SHIP_RADIUS,
            vx: Math.cos(player.angle) * PROJECTILE_SPEED,
            vy: Math.sin(player.angle) * PROJECTILE_SPEED,
            ownerId: socket.id,
            color: player.color
        });
    });
});

function resetGame() {
    matchTime = MATCH_DURATION;
    gameActive = true;
    teamKills = { blue: 0, red: 0 };
    matchResult = null;
    projectiles.length = 0;
    powerups.length = 0;

    for (let id in players) {
        players[id].score = 0;
        players[id].hp = 100;
        players[id].x = Math.random() * CANVAS_WIDTH;
        players[id].y = Math.random() * CANVAS_HEIGHT;
    }

    io.emit('gameReset');
    console.log('Game reset by operator');
}

function checkWinCondition() {
    if (!gameActive) return;

    let winner = null;
    let winnerType = null;

    // Check 30 kills limit
    for (let id in players) {
        if (players[id].team === 'solo' && players[id].score >= MAX_KILLS * 10) {
            winner = players[id].name;
            winnerType = 'PLAYER';
            break;
        }
    }

    if (teamKills.blue >= MAX_KILLS) {
        winner = 'BLUE TEAM';
        winnerType = 'TEAM';
    } else if (teamKills.red >= MAX_KILLS) {
        winner = 'RED TEAM';
        winnerType = 'TEAM';
    }

    // Check Time limit
    if (matchTime <= 0) {
        let topScore = -1;
        matchTime = 0;

        // Find highest score
        for (let id in players) {
            if (players[id].score > topScore) {
                topScore = players[id].score;
                winner = players[id].name;
                winnerType = 'PLAYER';
            }
        }

        if (teamKills.blue > teamKills.red) {
            winner = 'BLUE TEAM';
            winnerType = 'TEAM';
        } else if (teamKills.red > teamKills.blue) {
            winner = 'RED TEAM';
            winnerType = 'TEAM';
        }
    }

    if (winner) {
        gameActive = false;
        matchResult = { winner, winnerType };
        io.emit('gameOver', matchResult);
    }
}


// Game Loop (Update state and broadcast)
setInterval(() => {
    // Update projectiles
    for (let i = projectiles.length - 1; i >= 0; i--) {
        const p = projectiles[i];
        p.x += p.vx;
        p.y += p.vy;

        // Remove if out of bounds
        if (p.x < 0 || p.x > CANVAS_WIDTH || p.y < 0 || p.y > CANVAS_HEIGHT) {
            projectiles.splice(i, 1);
            continue;
        }

        // Obstacle collision
        let hitObs = false;
        for (const obs of obstacles) {
            if (p.x > obs.x && p.x < obs.x + obs.width && p.y > obs.y && p.y < obs.y + obs.height) {
                projectiles.splice(i, 1);
                io.emit('effect', { type: 'hit', x: p.x, y: p.y, color: '#aaa' });
                hitObs = true;
                break;
            }
        }
        if (hitObs) continue;

        // Collision detection
        for (let id in players) {
            if (id === p.ownerId) continue;
            const player = players[id];

            // Team check
            if (player.team !== 'solo' && player.team === players[p.ownerId]?.team) continue;

            const dist = Math.hypot(p.x - player.x, p.y - player.y);
            if (dist < SHIP_RADIUS) {
                // Hit!
                player.hp -= 10;

                io.emit('effect', { type: 'hit', x: p.x, y: p.y, color: player.color });

                if (player.hp <= 0) {
                    const victimName = player.name;
                    const killerName = players[p.ownerId] ? players[p.ownerId].name : 'Unknown';

                    players[p.ownerId].score += 10;

                    if (players[p.ownerId].team === 'blue') teamKills.blue++;
                    if (players[p.ownerId].team === 'red') teamKills.red++;

                    checkWinCondition();

                    // Respawn
                    player.x = Math.random() * CANVAS_WIDTH;
                    player.y = Math.random() * CANVAS_HEIGHT;
                    player.hp = 100;
                    io.emit('effect', { type: 'die', id: id });

                    // Kill Feed Event
                    io.emit('kill', { killer: killerName, victim: victimName, killerColor: players[p.ownerId]?.color, victimColor: player.color });
                }

                projectiles.splice(i, 1);
                break;
            }
        }
    }

    if (gameActive && matchTime > 0) {
        matchTime -= 1000 / 60;
        if (matchTime <= 0) checkWinCondition();
    }

    io.emit('stateUpdate', {
        players,
        projectiles,
        powerups,
        obstacles,
        timer: Math.max(0, matchTime),
        teamKills,
        gameActive
    });

    // Spawn powerups randomly
    if (powerups.length < 5 && Math.random() < 0.005) {
        const types = Object.keys(POWERUP_TYPES);
        const type = types[Math.floor(Math.random() * types.length)];
        powerups.push({
            id: Date.now() + Math.random(),
            x: Math.random() * CANVAS_WIDTH,
            y: Math.random() * CANVAS_HEIGHT,
            type: type
        });
    }

    // Update Powerups (collision)
    for (let i = powerups.length - 1; i >= 0; i--) {
        const pup = powerups[i];
        for (let id in players) {
            const player = players[id];
            const dist = Math.hypot(pup.x - player.x, pup.y - player.y);

            if (dist < SHIP_RADIUS + POWERUP_RADIUS) {
                // Apply Effect
                if (pup.type === 'HEALTH') {
                    player.hp = Math.min(player.hp + 50, player.maxHp);
                } else if (pup.type === 'SPEED') {
                    player.speedMult = 2;
                    setTimeout(() => { if (players[id]) players[id].speedMult = 1; }, 5000);
                } else if (pup.type === 'RAPID') {
                    player.fireRateMult = 3;
                    setTimeout(() => { if (players[id]) players[id].fireRateMult = 1; }, 5000);
                }

                io.emit('effect', { type: 'powerup', x: pup.x, y: pup.y });

                powerups.splice(i, 1);
                break;
            }
        }
    }
}, 1000 / 60); // 60 FPS update logic

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${port}`);
});
