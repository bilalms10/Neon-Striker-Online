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

// Mobile Input State will be defined later with the joystick logic to avoid duplication


let players: any = {}
let projectiles: any[] = []
let powerups: any[] = []
let obstacles: any[] = []
let particles: Particle[] = []
let isGameOver = false
let screenShake = 0
let matchTimer = 600000
let teamScores = { blue: 0, red: 0 }

class DamagePop {
  x: number;
  y: number;
  text: string;
  color: string;
  life: number = 1.0;
  vy: number = -1.5;

  constructor(x: number, y: number, text: string, color: string) {
    this.x = x;
    this.y = y;
    this.text = text;
    this.color = color;
  }

  update() {
    this.y += this.vy;
    this.life -= 0.02;
  }

  draw(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalAlpha = this.life;
    ctx.fillStyle = this.color;
    ctx.font = 'bold 16px Outfit';
    ctx.textAlign = 'center';
    // Removed shadowBlur for performance
    ctx.fillText(this.text, this.x, this.y);
    ctx.restore();
  }
}

let damagePops: DamagePop[] = [];
let playerFlashes: Record<string, number> = {};

// Performance optimizations: Off-screen background
const bgCanvas = document.createElement('canvas')
const bgCtx = bgCanvas.getContext('2d')!
bgCanvas.width = WORLD_WIDTH
bgCanvas.height = WORLD_HEIGHT

function initBackground() {
  bgCtx.fillStyle = '#050510'
  bgCtx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT)

  // Draw Stars once
  bgCtx.fillStyle = 'rgba(255, 255, 255, 0.5)'
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * WORLD_WIDTH
    const y = Math.random() * WORLD_HEIGHT
    const size = Math.random() * 2
    bgCtx.beginPath()
    bgCtx.arc(x, y, size, 0, Math.PI * 2)
    bgCtx.fill()
  }

  // Draw Grid once
  bgCtx.strokeStyle = 'rgba(0, 243, 255, 0.1)'
  bgCtx.lineWidth = 1
  for (let x = 0; x <= WORLD_WIDTH; x += 100) {
    bgCtx.beginPath(); bgCtx.moveTo(x, 0); bgCtx.lineTo(x, WORLD_HEIGHT); bgCtx.stroke();
  }
  for (let y = 0; y <= WORLD_HEIGHT; y += 100) {
    bgCtx.beginPath(); bgCtx.moveTo(0, y); bgCtx.lineTo(WORLD_WIDTH, y); bgCtx.stroke();
  }
}
initBackground()

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
    // Noise-like explosion
    const noiseBuffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.3, audioCtx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < noiseBuffer.length; i++) {
      output[i] = Math.random() * 2 - 1;
    }
    const noise = audioCtx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.setValueAtTime(400, now);
    noiseFilter.frequency.exponentialRampToValueAtTime(40, now + 0.3);

    const noiseGain = audioCtx.createGain();
    noiseGain.gain.setValueAtTime(0.3, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);

    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(audioCtx.destination);
    noise.start();
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

// Stars class removed in favor of static bgCanvas

// Input state
const keys: { [key: string]: boolean } = {}

window.addEventListener('keydown', (e) => {
  keys[e.code] = true

  // Lobby team switching
  if (lobbyScreen.style.display === 'flex') {
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
      socket.emit('joinTeam', 'blue')
    } else if (e.code === 'KeyD' || e.code === 'ArrowRight') {
      socket.emit('joinTeam', 'red')
    }
  }
})
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
const lobbyScreen = document.getElementById('lobby-screen')!
const uiContainer = document.getElementById('ui')!
const blueList = document.getElementById('blue-list')!
const redList = document.getElementById('red-list')!
const launchBtn = document.getElementById('launch-btn')!
const waitingMsg = document.getElementById('waiting-msg')!
const exitBtn = document.getElementById('exit-btn')!
const leaveLobbyBtn = document.getElementById('leave-lobby-btn')!
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
      screenShake = 15;
      if (data.id) playerFlashes[data.id] = 3; // 3 frames of white flash
      if (data.x && data.y) {
        damagePops.push(new DamagePop(data.x, data.y, '10', data.color || '#fff'));
      }
      break;
    case 'dash':
      playSound('shoot');
      screenShake = 8;
      break;
    case 'powerup':
      playSound('powerup');
      break;
    case 'explosion':
      playSound('explosion');
      screenShake = 25;
      createExplosionGroup(data.x, data.y, data.radius || 100);
      break;
    default:
      break;
  }
});

function createExplosionGroup(x: number, y: number, radius: number) {
  for (let i = 0; i < 20; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * radius;
    const px = x + Math.cos(angle) * dist;
    const py = y + Math.sin(angle) * dist;
    const color = i % 2 === 0 ? '#ffaa00' : '#ff5500';
    particles.push(new Particle(px, py, color, Math.random() * 4, Math.random() * 5 + 2));
  }
}

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

  if (selectedMode === 'team') {
    lobbyScreen.style.display = 'flex'
    uiContainer.style.display = 'none'
  } else {
    lobbyScreen.style.display = 'none'
    uiContainer.style.display = 'block'
  }

  if (audioCtx.state === 'suspended') audioCtx.resume()

  // Try to lock orientation
  if (window.innerWidth <= 1024 && (screen as any).orientation && (screen as any).orientation.lock) {
    (screen as any).orientation.lock('landscape').catch(() => {
      console.log('Orientation lock not supported or failed');
    });
  }
})

// Lobby Interaction
document.querySelectorAll('.join-team-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const team = btn.getAttribute('data-team')
    socket.emit('joinTeam', team)
  })
})

launchBtn.addEventListener('click', () => {
  socket.emit('startMatch')
})

exitBtn.addEventListener('click', () => {
  socket.emit('exitToHQ')
  location.reload()
})

leaveLobbyBtn.addEventListener('click', () => {
  socket.emit('exitToHQ')
  location.reload()
})

socket.on('lobbyUpdate', (playersInLobby: any[]) => {
  blueList.innerHTML = ''
  redList.innerHTML = ''

  let blueCount = 0
  let redCount = 0

  playersInLobby.forEach(p => {
    const li = document.createElement('li')
    li.textContent = p.name
    li.style.color = p.team === 'blue' ? '#00f3ff' : '#ff0055'
    if (p.team === 'blue') {
      blueList.appendChild(li)
      blueCount++
    } else if (p.team === 'red') {
      redList.appendChild(li)
      redCount++
    }
  })

  // Show launch button if there's at least one player on each team (or any for testing)
  if (blueCount > 0 && redCount > 0) {
    launchBtn.style.display = 'block'
    waitingMsg.style.display = 'none'
  } else {
    launchBtn.style.display = 'none'
    waitingMsg.style.display = 'block'
  }
})

socket.on('gameStarted', () => {
  lobbyScreen.style.display = 'none'
  uiContainer.style.display = 'block'
})

// Mobile Input State
const mobileInput: any = {
  up: false,
  targetAngle: undefined,
  fire: false,
  dash: false
}

// Mobile Joystick Logic
const joystickStick = document.getElementById('joystick-stick')!
const joystickBase = document.getElementById('joystick-base')!
const fireBtn = document.getElementById('mobile-fire-btn')!
const dashBtn = document.getElementById('mobile-dash-btn')!

let joystickTouchId: number | null = null
let joystickCenter = { x: 0, y: 0 }
let lastJoystickTap = 0

window.addEventListener('touchstart', (e: any) => {
  for (let i = 0; i < e.changedTouches.length; i++) {
    const touch = e.changedTouches[i]
    if (touch.clientX < window.innerWidth / 2 && joystickTouchId === null) {
      joystickTouchId = touch.identifier
      joystickCenter = { x: touch.clientX, y: touch.clientY }

      const now = Date.now()
      if (now - lastJoystickTap < 300) {
        mobileInput.dash = true
        setTimeout(() => mobileInput.dash = false, 150)
      }
      lastJoystickTap = now

      joystickBase.style.display = 'flex'
      joystickBase.style.left = `${touch.clientX}px`
      joystickBase.style.top = `${touch.clientY}px`
      joystickStick.style.transform = `translate(0px, 0px)`
      e.preventDefault()
    }
  }
}, { passive: false })

window.addEventListener('touchmove', (e) => {
  for (let i = 0; i < e.changedTouches.length; i++) {
    const touch = e.changedTouches[i]
    if (touch.identifier === joystickTouchId) {
      const dx = touch.clientX - joystickCenter.x
      const dy = touch.clientY - joystickCenter.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const maxDist = 50

      const ratio = Math.min(dist, maxDist) / dist || 0
      const moveX = dx * ratio
      const moveY = dy * ratio

      joystickStick.style.transform = `translate(${moveX}px, ${moveY}px)`

      // Movement logic
      if (dist > 10) {
        mobileInput.targetAngle = Math.atan2(dy, dx)
        mobileInput.up = dist > 20
      } else {
        mobileInput.up = false
      }

      e.preventDefault()
    }
  }
}, { passive: false })

window.addEventListener('touchend', (e) => {
  for (let i = 0; i < e.changedTouches.length; i++) {
    const touch = e.changedTouches[i]
    if (touch.identifier === joystickTouchId) {
      joystickTouchId = null
      joystickBase.style.display = 'none'
      mobileInput.up = false
      mobileInput.targetAngle = undefined
    }
  }
})

fireBtn.addEventListener('touchstart', (e: any) => {
  mobileInput.fire = true
  e.preventDefault()
}, { passive: false })
fireBtn.addEventListener('touchend', (e: any) => {
  mobileInput.fire = false
  e.preventDefault()
})

dashBtn.addEventListener('touchstart', (e: any) => {
  mobileInput.dash = true
  e.preventDefault()
}, { passive: false })
dashBtn.addEventListener('touchend', (e: any) => {
  mobileInput.dash = false
  e.preventDefault()
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

  // Pre-calculate visibility for culling
  const relX = player.x - camera.x;
  const relY = player.y - camera.y;
  if (relX < -100 || relX > canvas.width + 100 || relY < -100 || relY > canvas.height + 100) return;

  ctx.save()
  ctx.translate(player.x, player.y)

  // Impact Frame logic
  const isFlashing = playerFlashes[player.id] > 0;
  if (isFlashing) playerFlashes[player.id]--;

  // Draw Ship Body (Triangle)
  ctx.rotate(player.angle || 0)
  ctx.strokeStyle = isFlashing ? '#ffffff' : (player.color || 'white');
  ctx.lineWidth = isFlashing ? 5 : 3; // Thicker during flash
  ctx.lineJoin = 'round'

  ctx.beginPath()
  ctx.moveTo(20, 0)
  ctx.lineTo(-15, -15)
  ctx.lineTo(-10, 0)
  ctx.lineTo(-15, 15)
  ctx.closePath()
  ctx.stroke()

  if (isFlashing) {
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  // Cockpit
  ctx.fillStyle = isFlashing ? '#ffffff' : 'rgba(255, 255, 255, 0.8)'
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
  // Culling
  if (pup.x < camera.x - 50 || pup.x > camera.x + canvas.width + 50 ||
    pup.y < camera.y - 50 || pup.y > camera.y + canvas.height + 50) return;

  const colors: Record<string, string> = {
    HEALTH: '#00ff00',
    SPEED: '#ffff00',
    RAPID: '#ff00ff',
    SNIPER: '#ffffff',
    SHOTGUN: '#ff6600',
    MISSILE: '#ffaa00'
  };
  const label: Record<string, string> = {
    HEALTH: '+',
    SPEED: '⚡',
    RAPID: '>>>',
    SNIPER: 'SN',
    SHOTGUN: 'SG',
    MISSILE: 'MS'
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
  // Culling
  if (obs.x + obs.width < camera.x || obs.x > camera.x + canvas.width ||
    obs.y + obs.height < camera.y || obs.y > camera.y + canvas.height) return;

  ctx.save();
  ctx.translate(obs.x, obs.y);
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.fillRect(0, 0, obs.width, obs.height);
  ctx.restore();
}

function drawProjectile(proj: any) {
  // Culling
  if (proj.x < camera.x - 50 || proj.x > camera.x + canvas.width + 50 ||
    proj.y < camera.y - 50 || proj.y > camera.y + canvas.height + 50) return;

  ctx.save();
  ctx.translate(proj.x, proj.y);

  if (proj.weaponType === 'SNIPER') {
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    const angle = Math.atan2(proj.vy, proj.vx);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-15, 0);
    ctx.lineTo(15, 0);
    ctx.stroke();
  } else if (proj.weaponType === 'MISSILE') {
    const angle = Math.atan2(proj.vy, proj.vx);
    ctx.rotate(angle);
    ctx.fillStyle = '#ffaa00';
    ctx.beginPath();
    ctx.rect(-8, -4, 16, 8);
    ctx.fill();

    // Engine glow
    ctx.fillStyle = '#fff';
    ctx.fillRect(-10, -2, 4, 4);

    if (Math.random() < 0.3) {
      particles.push(new Particle(proj.x - proj.vx, proj.y - proj.vy, '#ff5500', 0.5, 2));
    }
  } else {
    ctx.fillStyle = proj.color ?? '#fff';
    ctx.beginPath();
    ctx.arc(0, 0, proj.size || 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ... rest of file ...

function gameLoop() {

  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // 1. Follow local player (Camera Update)
  const me = socket.id ? players[socket.id] : null
  if (me) {
    camera.x += (me.x - canvas.width / 2 - camera.x) * camera.lerp
    camera.y += (me.y - canvas.height / 2 - camera.y) * camera.lerp
  }

  // 2. Draw Background (Static)
  ctx.save()
  ctx.translate(-camera.x, -camera.y)
  ctx.drawImage(bgCanvas, 0, 0)
  ctx.restore()

  // 3. Draw World Objects (With Culling)
  ctx.save()
  ctx.translate(-camera.x, -camera.y)
  if (screenShake > 0) {
    const sx = (Math.random() - 0.5) * screenShake
    const sy = (Math.random() - 0.5) * screenShake
    ctx.translate(sx, sy)
    screenShake *= 0.9
    if (screenShake < 0.5) screenShake = 0
  }

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

  // Powerups, Obstacles, Players & Projectiles include internal culling
  if (powerups) powerups.forEach(drawPowerup)
  if (obstacles) obstacles.forEach(drawObstacle)

  for (let id in players) {
    if (players[id].hp > 0) {
      drawPlayer(players[id])

      // Limited Thruster particles for performance
      if (Math.random() < 0.1) {
        const p = players[id]
        const bx = p.x - Math.cos(p.angle) * 15
        const by = p.y - Math.sin(p.angle) * 15
        particles.push(new Particle(bx, by, '#00ffff', 1, 1.5))
      }
    }
  }

  projectiles.forEach(drawProjectile)

  // Damage Pops
  for (let i = damagePops.length - 1; i >= 0; i--) {
    damagePops[i].update();
    damagePops[i].draw(ctx);
    if (damagePops[i].life <= 0) damagePops.splice(i, 1);
  }

  // Particles Cap
  if (particles.length > 100) particles.splice(0, particles.length - 100);
  for (let i = particles.length - 1; i >= 0; i--) {
    particles[i].update()
    particles[i].draw(ctx)
    if (particles[i].life <= 0) particles.splice(i, 1)
  }

  ctx.restore()

  // 4. Draw UI Elements (Screen Space)
  drawUI();

  // Handle local input and send to server
  if (!typing && !isGameOver) {
    const input: any = {
      up: keys['KeyW'] || keys['ArrowUp'] || mobileInput.up,
      left: keys['KeyA'] || keys['ArrowLeft'],
      right: keys['KeyD'] || keys['ArrowRight'],
      dash: keys['ShiftLeft'] || keys['ShiftRight'] || mobileInput.dash,
      targetAngle: mobileInput.targetAngle
    }
    socket.emit('playerInput', input)

    if (keys['Space'] || mobileInput.fire) {
      socket.emit('shoot')
      keys['Space'] = false
      // No need to reset fire since it's button-state based on mobile
    }
  }


  requestAnimationFrame(gameLoop);
}

function drawUI() {
  ctx.fillStyle = 'var(--neon-blue)'
  ctx.font = 'bold 20px Outfit'
  ctx.textAlign = 'left'

  const minutes = Math.floor(matchTimer / 60000)
  const seconds = Math.floor((matchTimer % 60000) / 1000)
  const timerStr = `${minutes}:${seconds.toString().padStart(2, '0')}`

  ctx.fillText(`TIME: ${timerStr}`, 20, 60)

  if (teamScores.blue > 0 || teamScores.red > 0) {
    ctx.font = 'bold 16px Outfit'
    ctx.fillStyle = '#00f3ff'
    ctx.fillText(`BLUE: ${teamScores.blue}`, 20, 95)
    ctx.fillStyle = '#ff0055'
    ctx.fillText(`RED: ${teamScores.red}`, 20, 115)
  }

  // Weapon UI
  const me = socket.id ? players[socket.id] : null
  if (me) {
    const weaponY = canvas.height - 100;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(20, weaponY, 200, 60);
    ctx.strokeStyle = me.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(20, weaponY, 200, 60);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px Outfit';
    ctx.fillText(me.weapon === 'DEFAULT' ? 'PULSE GUN' : me.weapon, 35, weaponY + 25);

    ctx.font = '14px Outfit';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    const ammoText = me.ammo === Infinity ? '∞' : `AMMO: ${me.ammo}`;
    ctx.fillText(ammoText, 35, weaponY + 48);

    // Ammo Bar
    if (me.ammo !== Infinity) {
      const weaponMaxAmmo: Record<string, number> = { SNIPER: 5, SHOTGUN: 8, MISSILE: 5 };
      const max = weaponMaxAmmo[me.weapon] || 1;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.fillRect(110, weaponY + 38, 90, 10);
      ctx.fillStyle = me.color;
      ctx.fillRect(110, weaponY + 38, (me.ammo / max) * 90, 10);
    }
  }

  drawMinimap();
}

function drawMinimap() {
  const isMobile = window.innerWidth <= 1024;
  const mapSize = isMobile ? 120 : 180; // Smaller on mobile
  const padding = 20;
  const scale = mapSize / WORLD_WIDTH;

  // Move it left on mobile to avoid overlapping the fire button
  const startX = canvas.width - mapSize - (isMobile ? 160 : padding);
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
