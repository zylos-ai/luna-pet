const { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const VERSION = 'v0.4.0';
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
const SOUND_NAMES = ['done', 'waiting', 'stuck'];

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
let sounds = null;

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

function findSkinImage(dir, state) {
  for (const [ext, mime] of Object.entries(SKIN_EXTS)) {
    const file = path.join(dir, state + ext);
    if (fs.existsSync(file)) {
      return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    }
  }
  return null;
}

function loadSkinImagesFrom(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const images = {};
  for (const state of SKIN_STATES) {
    const img = findSkinImage(dir, state);
    if (!img) return null;
    images[state] = img;
  }
  for (const state of SKIN_OPTIONAL_STATES) {
    images[state] = findSkinImage(dir, state) || images.idle;
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
  return SKIN_STATES.filter((s) => !findSkinImage(dir, s));
}

function loadSounds() {
  if (sounds) return sounds;
  sounds = {};
  for (const name of SOUND_NAMES) {
    const file = path.join(__dirname, '..', 'assets', 'sounds', `${name}.wav`);
    if (fs.existsSync(file)) {
      sounds[name] = `data:audio/wav;base64,${fs.readFileSync(file).toString('base64')}`;
    }
  }
  return sounds;
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

// ---------- state mapping ----------

function mapAgentState(name) {
  const rec = fleetAgents.get(name) || {};
  const rich = name === selfName ? selfRich : null;

  if (!connected) {
    return { stateKey: 'offline', label: 'Reconnecting...', contextPct: 0 };
  }

  const state = ((rich?.state || rec.state) || 'UNKNOWN').toUpperCase();
  let stateKey = 'idle';
  let label = name;

  if (rich) {
    const isThinking = state === 'BUSY' && (!rich.running_tools || rich.running_tools.length === 0);
    const isWaiting = rich.source?.pending_permission;

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
      stateKey = 'thinking';
      label = rich.reason || 'Thinking...';
    } else if (state === 'BUSY') {
      stateKey = 'busy';
      const tool = rich.running_tools?.[0];
      if (tool) {
        const detail = tool.tool_detail ? `: ${tool.tool_detail.slice(0, 20)}` : '';
        label = `${tool.tool_name}${detail}`;
      } else {
        label = 'Working...';
      }
      const subs = rich.active_subagents?.length || 0;
      if (subs > 0) label = `Working (${subs} helper${subs > 1 ? 's' : ''})`;
    }
  } else {
    if (state === 'OFFLINE' || state === 'UNKNOWN') {
      stateKey = 'offline';
      label = 'Offline';
    } else if (state === 'STUCK' || state === 'POSSIBLY_STUCK') {
      stateKey = 'stuck';
      label = rec.activity || 'Stuck';
    } else if (state === 'BUSY') {
      stateKey = 'busy';
      label = rec.activity || 'Working...';
    }
  }

  const contextPct = rich?.context_pct ?? rec.context_pct ?? 0;
  return { stateKey, label: String(label).slice(0, 48), contextPct };
}

function sendState(name, win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('state', mapAgentState(name));
}

function pushAllStates() {
  for (const [name, win] of petWindows) sendState(name, win);
}

// ---------- pet windows ----------

function createPetWindow(name, index) {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const petSize = config.petSize;
  const pc = petConfig(name);
  const startX = pc.x >= 0 ? pc.x : width - petSize - 40 - index * (petSize + 10);
  const startY = pc.y >= 0 ? pc.y : height - petSize - 20;

  const win = new BrowserWindow({
    width: petSize,
    height: petSize + 30,
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
      sounds: loadSounds(),
      soundEnabled: config.soundEnabled,
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
      if (!win.isDestroyed()) win.close();
    }
    index += 1;
  }
  // close windows for agents no longer in the fleet
  for (const [name, win] of [...petWindows]) {
    if (!fleetAgents.has(name)) {
      petWindows.delete(name);
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
    win.webContents.send('skin', loadSkinImagesFor(pc));
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
  for (const win of petWindows.values()) {
    if (!win.isDestroyed()) win.webContents.send('sound-enabled', enabled);
  }
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
