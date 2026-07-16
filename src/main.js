const { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

// Pet windows are non-focusable and never receive a user gesture, which
// would leave WebAudio suspended forever under Chromium's autoplay policy.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const VERSION = 'v0.5.1';
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_PET = { visible: false, skin: 'octopus', customSkinDir: '', x: -1, y: -1 };
const DEFAULT_CONFIG = {
  dashboardUrl: 'https://luna.jinglever.com',
  apiKey: '',
  sessionToken: '',
  petSize: 120,
  soundEnabled: true,
  workbenchShown: false,
  pets: {},
};

const BUILTIN_SKINS = {
  octopus: path.join(__dirname, '..', 'assets', 'skins', 'octopus'),
};
const SKIN_STATES = ['idle', 'busy', 'thinking', 'stuck', 'offline'];
const SKIN_OPTIONAL_STATES = ['waiting'];
const SKIN_EXTS = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

let tray = null;
let setupWindow = null;
let workbenchWindow = null;
let config = { ...DEFAULT_CONFIG };
const petWindows = new Map();   // agent name -> BrowserWindow
const fleetAgents = new Map();  // agent name -> latest fleet record
let selfName = null;
let selfRich = null;            // latest detailed state payload (self agent only)
let allHidden = false;
let connected = false;
const prevStateKeys = new Map(); // agent name -> last stateKey seen (visible pets only)
const stateSince = new Map();    // agent name -> ts of last stateKey change (for the elapsed timer)
const lastCueAt = new Map();     // cue name -> ts, global rate limit

// ---------- config ----------

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
    }
  } catch {}
  if (!config.pets || typeof config.pets !== 'object') config.pets = {};
  // migrate v0.2/v0.3 single-pet fields into a pending default for the self agent
  if (config.skin !== undefined || config.customSkinDir !== undefined || config.idleX !== undefined) {
    config.legacyPet = {
      skin: config.skin === 'custom' ? 'custom' : 'octopus',
      customSkinDir: config.customSkinDir || '',
      x: config.idleX ?? -1,
      y: config.idleY ?? -1,
    };
    delete config.skin;
    delete config.customSkinDir;
    delete config.idleX;
    delete config.idleY;
    saveConfig();
  }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function petConfig(name) {
  if (!config.pets[name]) {
    const base = { ...DEFAULT_PET };
    if (name === selfName) {
      base.visible = true;
      if (config.legacyPet) {
        Object.assign(base, config.legacyPet, { visible: true });
        delete config.legacyPet;
      }
    }
    config.pets[name] = base;
    saveConfig();
  }
  return config.pets[name];
}

// ---------- skins & sounds ----------

function imageDataUrl(file, mime) {
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

// A state resolves to a frame list: numbered sequence `<state>-1.ext ...`
// (real frame-by-frame animation) wins over a single `<state>.ext`
// (animated gif/webp in a single file also animates natively in <img>).
function findStateFrames(dir, state) {
  const frames = [];
  for (let i = 1; i <= 120; i++) {
    let found = null;
    for (const [ext, mime] of Object.entries(SKIN_EXTS)) {
      const file = path.join(dir, `${state}-${i}${ext}`);
      if (fs.existsSync(file)) { found = imageDataUrl(file, mime); break; }
    }
    if (!found) break;
    frames.push(found);
  }
  if (frames.length > 0) return frames;
  for (const [ext, mime] of Object.entries(SKIN_EXTS)) {
    const file = path.join(dir, state + ext);
    if (fs.existsSync(file)) return [imageDataUrl(file, mime)];
  }
  return null;
}

// Optional skin.json in the folder: { "fps": 8, "states": { "busy": 12 } }
function readSkinMeta(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf-8'));
    return meta && typeof meta === 'object' ? meta : {};
  } catch { return {}; }
}

function loadSkinImagesFrom(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const meta = readSkinMeta(dir);
  const baseFps = Number(meta.fps) > 0 ? Number(meta.fps) : 8;
  const images = {};
  for (const state of SKIN_STATES) {
    const frames = findStateFrames(dir, state);
    if (!frames) return null;
    const fps = Number(meta.states?.[state]) > 0 ? Number(meta.states[state]) : baseFps;
    images[state] = { frames, fps };
  }
  for (const state of SKIN_OPTIONAL_STATES) {
    const frames = findStateFrames(dir, state);
    const fps = Number(meta.states?.[state]) > 0 ? Number(meta.states[state]) : baseFps;
    images[state] = frames ? { frames, fps } : images.idle;
  }
  return images;
}

function loadSkinImagesFor(pc) {
  let dir = BUILTIN_SKINS.octopus;
  if (pc.skin === 'custom' && pc.customSkinDir) dir = pc.customSkinDir;
  else if (BUILTIN_SKINS[pc.skin]) dir = BUILTIN_SKINS[pc.skin];
  return loadSkinImagesFrom(dir) || loadSkinImagesFrom(BUILTIN_SKINS.octopus);
}

function validateSkinDir(dir) {
  return SKIN_STATES.filter((s) => !findStateFrames(dir, s));
}

// ---------- sound cues (transition semantics mirror dashboard fleet-sounds) ----------

function isWorkingKey(key) {
  return key === 'busy' || key === 'thinking';
}

// First sighting seeds silently; busy<->thinking is not a transition;
// working->stuck gets its own cue rather than a misleading "finish".
function cueForTransition(prevKey, nextKey) {
  if (prevKey === undefined || prevKey === nextKey) return null;
  if (nextKey === 'waiting') return 'waiting';
  if (nextKey === 'stuck') return 'stuck';
  if (!isWorkingKey(prevKey) && isWorkingKey(nextKey)) return 'start';
  if (isWorkingKey(prevKey) && nextKey === 'idle') return 'finish';
  return null;
}

function triggerCue(cue) {
  if (!cue || !config.soundEnabled) return;
  const now = Date.now();
  if (now - (lastCueAt.get(cue) || 0) < 2000) return;
  lastCueAt.set(cue, now);
  let target = null;
  for (const win of petWindows.values()) {
    if (!win.isDestroyed()) { target = win; break; }
  }
  if (!target && workbenchWindow && !workbenchWindow.isDestroyed()) target = workbenchWindow;
  if (target) target.webContents.send('play-cue', cue);
}

// ---------- auth ----------

function exchangeApiKey(dashboardUrl, apiKey) {
  return new Promise((resolve, reject) => {
    const base = dashboardUrl.replace(/\/+$/, '');
    const url = new URL(`${base}/api/auth/token`);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 && parsed.token) {
            resolve(parsed.token);
          } else {
            reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          }
        } catch { reject(new Error('Invalid response')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------- SSE (single connection, main process) ----------

let sseAbort = null;
let sseReconnectTimer = null;

async function connectSSE() {
  if (sseAbort) {
    sseAbort.abort();
    sseAbort = null;
  }
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }

  const base = (config.dashboardUrl || '').replace(/\/+$/, '');
  if (!base) return;
  const headers = {};
  const token = config.sessionToken || config.apiKey;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  sseAbort = controller;

  try {
    const response = await fetch(`${base}/api/stream`, { headers, signal: controller.signal });

    if (!response.ok) {
      if (response.status === 401 && config.apiKey) {
        const fresh = await exchangeApiKey(config.dashboardUrl, config.apiKey).catch(() => null);
        if (fresh) {
          config.sessionToken = fresh;
          saveConfig();
          return connectSSE();
        }
      }
      throw new Error(`HTTP ${response.status}`);
    }

    setConnected(true);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData = line.slice(6);
        } else if (line === '' && currentData) {
          handleSSEEvent(currentEvent, currentData);
          currentEvent = '';
          currentData = '';
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
  }
  if (sseAbort === controller) {
    setConnected(false);
    sseReconnectTimer = setTimeout(connectSSE, 5000);
  }
}

function setConnected(value) {
  connected = value;
  pushWorkbench();
  if (!value) {
    for (const [name, win] of petWindows) {
      sendState(name, win);
    }
  }
}

function handleSSEEvent(event, dataStr) {
  let data;
  try { data = JSON.parse(dataStr); } catch { return; }

  if (event === 'fleet') {
    const agents = Array.isArray(data.agents) ? data.agents : [];
    if (agents.length === 0) return;
    const seen = new Set();
    for (const agent of agents) {
      if (!agent || !agent.name) continue;
      seen.add(agent.name);
      fleetAgents.set(agent.name, agent);
      if (agent.self) selfName = agent.name;
    }
    for (const name of [...fleetAgents.keys()]) {
      if (!seen.has(name)) fleetAgents.delete(name);
    }
    syncPetWindows();
    pushAllStates();
    pushWorkbench();
  } else if (event === 'fleet_state' || event === 'state_change') {
    const payload = data.self || data;
    selfRich = payload;
    if (!selfName && payload?.agent?.name) {
      selfName = payload.agent.name;
      if (!fleetAgents.has(selfName)) {
        fleetAgents.set(selfName, { name: selfName, state: payload.state, self: true });
        syncPetWindows();
        pushWorkbench();
      }
    }
    if (selfName) {
      const rec = fleetAgents.get(selfName);
      if (rec) rec.state = payload.state || rec.state;
      const win = petWindows.get(selfName);
      if (win) sendState(selfName, win);
      pushWorkbench();
    }
  }
}

// ---------- identity tint (mirrors zylos-dashboard agent-color.js) ----------

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (const ch of String(value || '')) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function agentHue(name) {
  const rec = fleetAgents.get(name);
  const remote = Number(rec?.hue);
  if (Number.isFinite(remote)) return ((remote % 360) + 360) % 360;
  return fnv1a32(String(name || '').toLowerCase()) % 360;
}

// Only built-in skins get the identity tint; custom skins render as authored.
function petTint(name) {
  const pc = petConfig(name);
  return pc.skin === 'custom' ? null : agentHue(name);
}

// ---------- state mapping ----------

// `label` is workbench-facing activity text; the pet itself shows `bubble` —
// the agent's last spoken reply — so tool internals never reach the pet.
function mapAgentState(name) {
  const rec = fleetAgents.get(name) || {};
  const rich = name === selfName ? selfRich : null;

  if (!connected) {
    return { stateKey: 'offline', label: 'Reconnecting...', bubble: '', contextPct: 0, subCount: 0, hasSubs: false };
  }

  const state = ((rich?.state || rec.state) || 'UNKNOWN').toUpperCase();
  let stateKey = 'idle';
  let label = name;
  let toolStartedAt = null;
  let bubble = '';
  let subCount = 0;
  let hasSubs = false;

  if (rich) {
    const isThinking = state === 'BUSY' && (!rich.running_tools || rich.running_tools.length === 0);
    const isWaiting = rich.source?.pending_permission;
    const lastMsg = rich.last_message;
    const lastMsgText = typeof lastMsg === 'string' ? lastMsg : lastMsg?.text;
    bubble = lastMsgText || '';
    subCount = rich.active_subagents?.length || 0;
    hasSubs = subCount > 0;

    if (state === 'OFFLINE' || state === 'UNKNOWN') {
      stateKey = 'offline';
      label = 'Sleeping...';
    } else if (state === 'STUCK' || state === 'POSSIBLY_STUCK') {
      stateKey = 'stuck';
      label = rich.reason || 'Stuck';
    } else if (isWaiting) {
      stateKey = 'waiting';
      label = 'Waiting for you';
    } else if (isThinking) {
      // rich.reason says "Thinking (Ns)" where N is the whole turn's age, not
      // time spent thinking — misleading, so never surface it. The pet's own
      // timer (since last state change) is the honest elapsed value.
      stateKey = 'thinking';
      label = 'Thinking...';
    } else if (state === 'BUSY') {
      stateKey = 'busy';
      const tool = rich.running_tools?.[0];
      if (tool) {
        const detail = tool.tool_detail ? `: ${tool.tool_detail.slice(0, 120)}` : '';
        label = `${tool.tool_name}${detail}`;
        if (tool.started_at) {
          const ts = new Date(tool.started_at).getTime();
          if (Number.isFinite(ts)) toolStartedAt = ts;
        }
      } else {
        label = 'Working...';
      }
    } else if (lastMsgText) {
      // idle: surface the last assistant reply
      label = lastMsgText;
    }
  } else {
    hasSubs = rec.has_subagent === true;
    subCount = 0; // remote fleet records only carry a boolean
    if (state === 'OFFLINE' || state === 'UNKNOWN') {
      stateKey = 'offline';
      label = 'Offline';
    } else if (state === 'STUCK' || state === 'POSSIBLY_STUCK') {
      stateKey = 'stuck';
      label = rec.activity || 'Stuck';
    } else if (state === 'BUSY') {
      stateKey = 'busy';
      label = rec.activity || 'Working...';
    } else if (rec.activity) {
      label = rec.activity;
    }
  }

  const contextPct = rich?.context_pct ?? rec.context_pct ?? 0;
  return {
    stateKey,
    label: String(label).slice(0, 320),
    bubble: String(bubble).slice(0, 320),
    contextPct,
    toolStartedAt,
    subCount,
    hasSubs,
  };
}

function sendState(name, win) {
  if (!win || win.isDestroyed()) return;
  const mapped = mapAgentState(name);
  const prevKey = prevStateKeys.get(name);
  triggerCue(cueForTransition(prevKey, mapped.stateKey));
  prevStateKeys.set(name, mapped.stateKey);
  if (prevKey !== mapped.stateKey || !stateSince.has(name)) {
    stateSince.set(name, Date.now());
  }
  win.webContents.send('state', {
    ...mapped,
    tint: petTint(name),
    since: stateSince.get(name),
  });
}

function pushAllStates() {
  for (const [name, win] of petWindows) sendState(name, win);
}

// ---------- pet windows ----------

function createPetWindow(name, index) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const petSize = config.petSize;
  const winW = Math.max(petSize, 176);
  const winH = petSize + 100;
  const pc = petConfig(name);
  const startX = pc.x >= 0 ? pc.x : width - winW - 40 - index * (winW + 10);
  const startY = pc.y >= 0 ? pc.y : height - winH - 20;

  const win = new BrowserWindow({
    width: winW,
    height: winH,
    x: startX,
    y: startY,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'pet.html'));

  win.webContents.on('did-finish-load', () => {
    win.webContents.send('init', {
      agentName: name,
      skinImages: loadSkinImagesFor(pc),
      tint: petTint(name),
    });
    sendState(name, win);
  });

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    pc.x = x;
    pc.y = y;
    saveConfig();
  });

  petWindows.set(name, win);
  return win;
}

function syncPetWindows() {
  let index = 0;
  for (const name of fleetAgents.keys()) {
    const pc = petConfig(name);
    const shouldShow = pc.visible && !allHidden;
    const win = petWindows.get(name);
    if (shouldShow && !win) {
      createPetWindow(name, index);
    } else if (!shouldShow && win) {
      petWindows.delete(name);
      prevStateKeys.delete(name);
      stateSince.delete(name);
      if (!win.isDestroyed()) win.close();
    }
    index += 1;
  }
  // close windows for agents no longer in the fleet
  for (const [name, win] of [...petWindows]) {
    if (!fleetAgents.has(name)) {
      petWindows.delete(name);
      prevStateKeys.delete(name);
      stateSince.delete(name);
      if (!win.isDestroyed()) win.close();
    }
  }
}

// ---------- workbench ----------

function openWorkbench() {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    workbenchWindow.show();
    workbenchWindow.focus();
    return;
  }
  workbenchWindow = new BrowserWindow({
    width: 520,
    height: 560,
    resizable: true,
    minWidth: 440,
    minHeight: 420,
    title: 'Luna Pet — Workbench',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  workbenchWindow.loadFile(path.join(__dirname, 'workbench.html'));
  workbenchWindow.on('closed', () => { workbenchWindow = null; });
  workbenchWindow.webContents.on('did-finish-load', () => pushWorkbench());
}

function workbenchData() {
  const agents = [];
  for (const [name, rec] of fleetAgents) {
    const pc = petConfig(name);
    const mapped = mapAgentState(name);
    agents.push({
      name,
      self: name === selfName,
      color: rec.color || null,
      state: mapped.stateKey,
      label: mapped.label,
      contextPct: mapped.contextPct,
      visible: pc.visible,
      skin: pc.skin,
      customSkinDir: pc.customSkinDir || '',
    });
  }
  agents.sort((a, b) => (b.self - a.self) || a.name.localeCompare(b.name));
  return {
    version: VERSION,
    connected,
    soundEnabled: config.soundEnabled,
    dashboardUrl: config.dashboardUrl,
    hasApiKey: Boolean(config.apiKey),
    allHidden,
    agents,
  };
}

function pushWorkbench() {
  if (workbenchWindow && !workbenchWindow.isDestroyed()) {
    workbenchWindow.webContents.send('wb-data', workbenchData());
  }
}

// ---------- setup window (first run) ----------

function showSetup() {
  setupWindow = new BrowserWindow({
    width: 420,
    height: 320,
    resizable: false,
    frame: true,
    title: 'Luna Pet — Setup',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  setupWindow.loadFile(path.join(__dirname, 'setup.html'));

  setupWindow.webContents.on('did-finish-load', () => {
    setupWindow.webContents.send('prefill', {
      dashboardUrl: config.dashboardUrl,
      apiKey: config.apiKey,
    });
  });
}

// ---------- IPC ----------

ipcMain.handle('save-config', async (_event, { dashboardUrl, apiKey }) => {
  try {
    const token = await exchangeApiKey(dashboardUrl, apiKey);
    config.dashboardUrl = dashboardUrl;
    config.apiKey = apiKey;
    config.sessionToken = token;
    saveConfig();

    if (setupWindow) {
      setupWindow.close();
      setupWindow = null;
    }
    connectSSE();
    if (!config.workbenchShown) {
      config.workbenchShown = true;
      saveConfig();
      openWorkbench();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('wb-get-data', () => workbenchData());

ipcMain.on('wb-set-visible', (_event, { name, visible }) => {
  const pc = petConfig(name);
  pc.visible = Boolean(visible);
  saveConfig();
  syncPetWindows();
  pushWorkbench();
});

ipcMain.handle('wb-set-skin', (_event, { name, skin }) => {
  const pc = petConfig(name);
  if (skin === 'custom') {
    const result = dialog.showOpenDialogSync(workbenchWindow, {
      title: 'Choose Skin Folder',
      message: 'Pick a folder containing idle / busy / thinking / stuck / offline images (png, gif, webp or jpg). Optional: waiting.',
      properties: ['openDirectory'],
    });
    if (!result || !result[0]) return { ok: false };
    const missing = validateSkinDir(result[0]);
    if (missing.length > 0) {
      dialog.showErrorBox(
        'Invalid Skin Folder',
        `Missing images: ${missing.map((s) => s + '.png').join(', ')}\n\nThe folder must contain one image per state, named idle / busy / thinking / stuck / offline (extensions: png, gif, webp, jpg).`
      );
      return { ok: false };
    }
    pc.customSkinDir = result[0];
    pc.skin = 'custom';
  } else {
    pc.skin = BUILTIN_SKINS[skin] ? skin : 'octopus';
  }
  saveConfig();
  const win = petWindows.get(name);
  if (win && !win.isDestroyed()) {
    win.webContents.send('skin', { images: loadSkinImagesFor(pc), tint: petTint(name) });
  }
  pushWorkbench();
  return { ok: true };
});

ipcMain.on('wb-set-sound', (_event, { enabled }) => {
  setSoundEnabled(Boolean(enabled));
});

ipcMain.handle('wb-save-settings', async (_event, { dashboardUrl, apiKey, keepKey }) => {
  try {
    if (keepKey && !apiKey) apiKey = config.apiKey;
    if (!apiKey) return { ok: false, error: 'API key is required.' };
    const token = await exchangeApiKey(dashboardUrl, apiKey);
    config.dashboardUrl = dashboardUrl;
    config.apiKey = apiKey;
    config.sessionToken = token;
    saveConfig();
    connectSSE();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function setSoundEnabled(enabled) {
  config.soundEnabled = enabled;
  saveConfig();
  if (enabled) triggerCue('start'); // audible confirmation, mirrors dashboard unmute
  rebuildTrayMenu();
  pushWorkbench();
}

function setAllHidden(hidden) {
  allHidden = hidden;
  syncPetWindows();
  rebuildTrayMenu();
  pushWorkbench();
}

// ---------- tray ----------

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Luna Pet');
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    { label: `Luna Pet ${VERSION}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Workbench', click: () => openWorkbench() },
    {
      label: allHidden ? 'Show All Pets' : 'Hide All Pets',
      click: () => setAllHidden(!allHidden),
    },
    {
      label: 'Sound Effects',
      type: 'checkbox',
      checked: config.soundEnabled,
      click: (item) => setSoundEnabled(item.checked),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
}

// ---------- app lifecycle ----------

app.whenReady().then(() => {
  loadConfig();
  createTray();

  if (config.apiKey) {
    connectSSE();
    if (!config.workbenchShown) {
      config.workbenchShown = true;
      saveConfig();
      openWorkbench();
    }
  } else {
    showSetup();
  }
});

app.on('window-all-closed', (e) => e.preventDefault());
