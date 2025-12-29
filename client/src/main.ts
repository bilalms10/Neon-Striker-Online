import './style.css'
import { io } from 'socket.io-client'

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!
const scoreList = document.getElementById('scoreList')!

canvas.width = window.innerWidth
canvas.height = window.innerHeight

const WORLD_WIDTH = 2000
const WORLD_HEIGHT = 2000

const camera = {
  x: 0,
  y: 0,
  lerp: 0.1
}

// Socket connection
const socket = io(window.location.hostname === 'localhost' ? 'http://localhost:3000' : '/')

let players: any = {}
let projectiles: any[] = []
let powerups: any[] = []
let obstacles: any[] = []
let particles: Particle[] = []
let stars: Star[] = []
let screenShake = 0
let lastCamera = { x: 0, y: 0 }
let matchTimer = 600000
let teamScores = { blue: 0, red: 0 }
let isGameOver = false

// Audio Context
const AudioContext = window.AudioContext || (window as any).webkitAudioContext
const audioCtx = new AudioContext()

function playSound(type: 'shoot' | 'explosion' | 'powerup') {
  if (audioCtx.state === 'suspended') audioCtx.resume()
  const osc = audioCtx.createOscillator()
  const gain = audioCtx.createGain()
  osc.connect(gain)
  gain.connect(audioCtx.destination)

  const now = audioCtx.currentTime

  if (type === 'shoot') {
    osc.type = 'square'
    osc.frequency.setValueAtTime(800, now)
    osc.frequency.exponentialRampToValueAtTime(100, now + 0.1)
    gain.gain.setValueAtTime(0.1, now)
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1)
    osc.start(now)
    osc.stop(now + 0.1)
  } else if (type === 'explosion') {
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(100, now)
    osc.frequency.exponentialRampToValueAtTime(10, now + 0.3)
    gain.gain.setValueAtTime(0.2, now)
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3)
    osc.start(now)
    osc.stop(now + 0.3)
  } else if (type === 'powerup') {
    osc.type = 'sine'
    osc.frequency.setValueAtTime(600, now)
    osc.frequency.linearRampToValueAtTime(1200, now + 0.1)
    gain.gain.setValueAtTime(0.1, now)
    gain.gain.linearRampToValueAtTime(0, now + 0.3)
    osc.start(now)
    osc.stop(now + 0.3)
  }
}

class Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  color: string
  size: number

  constructor(x: number, y: number, color: string, speed: number, size: number) {
    this.x = x
    this.y = y
    const angle = Math.random() * Math.PI * 2
    this.vx = Math.cos(angle) * speed
    this.vy = Math.sin(angle) * speed
    this.life = 1.0
    this.color = color
    this.size = size
  }

  update() {
    this.x += this.vx
    this.y += this.vy
    this.life -= 0.02
    this.size *= 0.95
  }

  draw(ctx: CanvasRenderingContext2D) {
    ctx.globalAlpha = this.life
    ctx.fillStyle = this.color
    ctx.beginPath()
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1.0
  }
}

class Star {
  x: number;
  y: number;
  z: number;

  constructor() {
    this.x = Math.random() * canvas.width
    this.y = Math.random() * canvas.height
    this.z = Math.random() * 2 + 0.5 // Depth/Speed
  }

  update(dx: number, dy: number) {
    this.x -= dx * this.z * 0.1 // Parallax effect
    this.y -= dy * this.z * 0.1

    // Wrap
    if (this.x < 0) this.x += canvas.width
    if (this.x > canvas.width) this.x -= canvas.width
    if (this.y < 0) this.y += canvas.height
    if (this.y > canvas.height) this.y -= canvas.height
  }

  draw(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.random() * 0.5 + 0.2})`
    ctx.beginPath()
    ctx.arc(this.x, this.y, this.z, 0, Math.PI * 2)
    ctx.fill()
  }
}



// Init stars
for (let i = 0; i < 150; i++) stars.push(new Star())

// Input state
const keys: { [key: string]: boolean } = {}

window.addEventListener('keydown', (e) => (keys[e.code] = true))
window.addEventListener('keyup', (e) => (keys[e.code] = false))

// Start Screen Logic
const loginScreen = document.getElementById('login-screen')!
const startBtn = document.getElementById('start-btn')!
const usernameInput = document.getElementById('username') as HTMLInputElement
const modeBtns = document.querySelectorAll('.mode-btn')

// Chat & Feed Elements
const chatInput = document.getElementById('chat-input') as HTMLInputElement
const chatList = document.getElementById('chat-messages')!
const killFeed = document.getElementById('kill-feed')!
let typing = false;

chatInput.addEventListener('focus', () => typing = true)
chatInput.addEventListener('blur', () => typing = false)
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && chatInput.value.trim().length > 0) {
    socket.emit('chat', chatInput.value.trim());
    chatInput.value = '';
    chatInput.blur();
    typing = false;
  }
  e.stopPropagation();
});

socket.on('chatMessage', (data: any) => {
  const li = document.createElement('li');
  li.innerHTML = `<span class="name" style="color: ${data.color}">${data.name}:</span> ${data.text}`;
  chatList.appendChild(li);
  chatList.scrollTop = chatList.scrollHeight;
});

socket.on('kill', (data: any) => {
  const div = document.createElement('div');
  div.className = 'kill-msg';
  div.innerHTML = `<span style="color:${data.killerColor}">${data.killer}</span> killed <span style="color:${data.victimColor}">${data.victim}</span>`;
  killFeed.appendChild(div);
  setTimeout(() => div.remove(), 5000);
});

// Effect handling
socket.on('effect', (data: any) => {
  switch (data.type) {
    case 'shoot':
      playSound('shoot');
      break;
    case 'hit':
      playSound('explosion');
      screenShake = 15; // trigger screen shake on hit
      break;
    case 'dash':
      playSound('shoot');
      screenShake = 8;
      break;
    case 'powerup':
      playSound('powerup');
      break;
    default:
      break;
  }
});

let selectedMode = 'solo'

modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    modeBtns.forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    selectedMode = btn.getAttribute('data-mode')!
  })
})

// Start Game
startBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim() || 'OPERATOR'
  socket.emit('join', { name, mode: selectedMode })
  loginScreen.style.display = 'none'
  document.getElementById('ui')!.style.display = 'block'
  if (audioCtx.state === 'suspended') audioCtx.resume()
})

socket.on('connect', () => {
  console.log('Connected to server');
});

socket.on('gameOver', (data: any) => {
  isGameOver = true;
  const overlay = document.createElement('div');
  overlay.id = 'game-over-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>MISSION ${data.winnerType === 'TEAM' ? 'SUCCESS' : 'COMPLETE'}</h2>
      <p class="winner">${data.winner} WINS!</p>
      <button onclick="location.reload()">REDEPLOY</button>
    </div>
  `;
  document.body.appendChild(overlay);
});

socket.on('gameReset', () => {
  const overlay = document.getElementById('game-over-overlay');
  if (overlay) overlay.remove();
  isGameOver = false;
});


socket.on('stateUpdate', (data: any) => {
  // Check for events to trigger effects
  // We need a way to detect changes. For now we will infer from data or add event emission.
  // Actually, let's just use the 'shoot' event if we broadcast it, or infer from new projectiles?
  // Inferring is hard. Let's add specific event listeners for 'sound' events from server later.
  // For now, let's just trigger shoot sound on local shoot? No, we need to hear others.

  // Simple hack: if projectile count increases significantly, play sound? Unreliable.
  // Let's add a socket listener for 'effect'.

  players = data.players
  projectiles = data.projectiles
  powerups = data.powerups
  obstacles = data.obstacles
  matchTimer = data.timer
  teamScores = data.teamKills
  updateLeaderboard()
})


function updateLeaderboard() {
  const sortedPlayers = Object.values(players).sort((a: any, b: any) => b.score - a.score)
  scoreList.innerHTML = sortedPlayers
    .slice(0, 5)
    .map(
      (p: any) =>
        `<li><span style="color: ${p.color}">[${p.team === 'solo' ? 'SOLO' : p.team.toUpperCase()}] ${p.name}</span> <span>${p.score}</span></li>`
    )
    .join('')
}





function drawPlayer(player: any) {
  if (!player) return

  ctx.save()
  ctx.translate(player.x, player.y)

  // Glow Effect
  ctx.shadowBlur = 15;
  ctx.shadowColor = player.color;

  // Draw Ship Body (Triangle)
  ctx.rotate(player.angle || 0)
  ctx.strokeStyle = player.color || 'white'
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'

  ctx.beginPath()
  ctx.moveTo(20, 0)
  ctx.lineTo(-15, -15)
  ctx.lineTo(-10, 0)
  ctx.lineTo(-15, 15)
  ctx.closePath()
  ctx.stroke()

  // Cockpit
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
  ctx.beginPath()
  ctx.arc(0, 0, 5, 0, Math.PI * 2)
  ctx.fill()

  // HP Bar
  ctx.rotate(-(player.angle || 0)) // Unrotate for HP
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#333'
  ctx.fillRect(-20, 30, 40, 4)
  ctx.fillStyle = player.hp > 30 ? player.color : '#ff0000'
  ctx.fillRect(-20, 30, (player.hp / 100) * 40, 4)

  // Name
  ctx.fillStyle = 'white'
  ctx.font = 'bold 12px Outfit'
  ctx.textAlign = 'center'
  ctx.fillText(player.name || '?', 0, -35)

  ctx.restore()
}

// ----------------------------------------------------------------------
// DRAW HELPERS – power‑ups, obstacles, projectiles
// ----------------------------------------------------------------------
function drawPowerup(pup: any) {
  const colors: Record<string, string> = {
    HEALTH: '#00ff00',
    SPEED: '#ffff00',
    RAPID: '#ff00ff',
  };
  const label: Record<string, string> = {
    HEALTH: '+',
    SPEED: '⚡',
    RAPID: '>>>',
  };
  ctx.save();
  ctx.translate(pup.x, pup.y);
  ctx.fillStyle = colors[pup.type] ?? '#fff';
  ctx.beginPath();
  ctx.arc(0, 0, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = '12px Outfit';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label[pup.type] ?? '?', 0, 0);
  ctx.restore();
}

function drawObstacle(obs: any) {
  ctx.save();
  ctx.translate(obs.x, obs.y);
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.fillRect(0, 0, obs.width, obs.height);
  ctx.restore();
}

function drawProjectile(proj: any) {
  ctx.save();
  ctx.translate(proj.x, proj.y);
  ctx.fillStyle = proj.color ?? '#fff';
  ctx.beginPath();
  ctx.arc(0, 0, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ... rest of file ...

function gameLoop() {
  // Update shake
  if (screenShake > 0) screenShake *= 0.9
  if (screenShake < 0.5) screenShake = 0
  const shakeX = (Math.random() - 0.5) * screenShake
  const shakeY = (Math.random() - 0.5) * screenShake

  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Background
  ctx.fillStyle = '#050510'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  // Debug Info / Timer
  ctx.fillStyle = 'var(--neon-blue)'
  ctx.font = 'bold 20px Outfit'
  ctx.textAlign = 'left'

  const minutes = Math.floor(matchTimer / 60000)
  const seconds = Math.floor((matchTimer % 60000) / 1000)
  const timerStr = `${minutes}:${seconds.toString().padStart(2, '0')}`

  ctx.fillText(`TIME: ${timerStr}`, 20, 60)
  ctx.font = '14px Outfit'
  ctx.fillText(`ELIMINATION LIMIT: 30`, 20, 85)

  // Team Scores
  if (teamScores.blue > 0 || teamScores.red > 0) {
    ctx.font = 'bold 16px Outfit'
    ctx.fillStyle = '#00f3ff'
    ctx.fillText(`BLUE TEAM: ${teamScores.blue}`, 20, 115)
    ctx.fillStyle = '#ff0055'
    ctx.fillText(`RED TEAM: ${teamScores.red}`, 20, 135)
  }

  const camDx = camera.x - lastCamera.x
  const camDy = camera.y - lastCamera.y
  lastCamera.x = camera.x
  lastCamera.y = camera.y

  stars.forEach(s => {
    s.update(camDx, camDy)
    s.draw(ctx)
  })

  ctx.save()

  // Follow local player
  const me = socket.id ? players[socket.id] : null
  if (me) {
    camera.x += (me.x - canvas.width / 2 - camera.x) * camera.lerp
    camera.y += (me.y - canvas.height / 2 - camera.y) * camera.lerp
  }

  ctx.translate(-camera.x, -camera.y)
  if (screenShake) ctx.translate(shakeX, shakeY)

  // Grid Lines
  ctx.strokeStyle = 'rgba(0, 243, 255, 0.05)'
  ctx.lineWidth = 1
  for (let x = 0; x <= WORLD_WIDTH; x += 100) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_HEIGHT); ctx.stroke();
  }
  for (let y = 0; y <= WORLD_HEIGHT; y += 100) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_WIDTH, y); ctx.stroke();
  }

  // World Border
  ctx.strokeStyle = '#ff00ff'
  ctx.lineWidth = 5
  ctx.shadowBlur = 15
  ctx.shadowColor = '#ff00ff'
  ctx.strokeRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT)
  ctx.shadowBlur = 0

  // Powerups
  if (powerups) powerups.forEach(drawPowerup)

  // Obstacles
  if (obstacles) obstacles.forEach(drawObstacle)

  // Draw players
  for (let id in players) {
    if (players[id].hp > 0) {
      drawPlayer(players[id])

      // Thruster particles
      if (Math.random() < 0.3) {
        const p = players[id]
        const bx = p.x - Math.cos(p.angle) * 15
        const by = p.y - Math.sin(p.angle) * 15
        particles.push(new Particle(bx, by, '#00ffff', 1, 2))
      }
    } else {
      // Dead?
    }
  }

  // Draw projectiles
  projectiles.forEach(drawProjectile)

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update()
    particles[i].draw(ctx)
    if (particles[i].life <= 0) particles.splice(i, 1)
  }

  ctx.restore()

  // Handle local input and send to server
  if (!typing && !isGameOver) {
    const input = {
      up: keys['KeyW'] || keys['ArrowUp'],
      left: keys['KeyA'] || keys['ArrowLeft'],
      right: keys['KeyD'] || keys['ArrowRight'],
      dash: keys['ShiftLeft'] || keys['ShiftRight']
    }
    socket.emit('playerInput', input)

    if (keys['Space']) {
      socket.emit('shoot')
      keys['Space'] = false
    }
  }

  // Draw Minimap
  drawMinimap();

  requestAnimationFrame(gameLoop)
}

function drawMinimap() {
  const mapSize = 180;
  const padding = 20;
  const scale = mapSize / WORLD_WIDTH;

  const startX = canvas.width - mapSize - padding;
  const startY = canvas.height - mapSize - padding;

  ctx.save();
  ctx.translate(startX, startY);

  // Background
  ctx.fillStyle = 'rgba(0, 10, 20, 0.8)';
  ctx.strokeStyle = 'var(--neon-blue)';
  ctx.lineWidth = 2;
  ctx.fillRect(0, 0, mapSize, mapSize);
  ctx.strokeRect(0, 0, mapSize, mapSize);

  // Camera Viewport Box
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.strokeRect(camera.x * scale, camera.y * scale, (canvas.width * scale), (canvas.height * scale));

  // Players
  for (const id in players) {
    const p = players[id];
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x * scale, p.y * scale, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Obstacles
  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  for (const obs of obstacles) {
    ctx.fillRect(obs.x * scale, obs.y * scale, obs.width * scale, obs.height * scale);
  }

  ctx.restore();
}

// Resizing
window.addEventListener('resize', () => {
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight
  // Re-init stars? Nah
})

gameLoop()
