const { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  dashboardUrl: 'https://luna.jinglever.com',
  apiKey: '',
  sessionToken: '',
  petSize: 120,
  idleX: -1,
  idleY: -1,
  skin: 'octopus',
  customSkinDir: '',
};

const BUILTIN_SKINS = {
  octopus: path.join(__dirname, '..', 'assets', 'skins', 'octopus'),
};
const SKIN_STATES = ['idle', 'busy', 'thinking', 'stuck', 'offline'];
const SKIN_OPTIONAL_STATES = ['waiting'];
const SKIN_EXTS = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function findSkinImage(dir, state) {
  for (const [ext, mime] of Object.entries(SKIN_EXTS)) {
    const file = path.join(dir, state + ext);
    if (fs.existsSync(file)) {
      return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    }
  }
  return null;
}

// Returns { idle, busy, thinking, stuck, offline, waiting } as data URLs.
// Falls back to the built-in octopus skin if the selected folder is invalid.
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

function loadSkinImages() {
  let dir = BUILTIN_SKINS.octopus;
  if (config.skin === 'custom' && config.customSkinDir) dir = config.customSkinDir;
  else if (BUILTIN_SKINS[config.skin]) dir = BUILTIN_SKINS[config.skin];
  return loadSkinImagesFrom(dir) || loadSkinImagesFrom(BUILTIN_SKINS.octopus);
}

function validateSkinDir(dir) {
  const missing = SKIN_STATES.filter((s) => !findSkinImage(dir, s));
  return missing;
}

function applySkin() {
  if (mainWindow) {
    mainWindow.webContents.send('skin', loadSkinImages());
  }
}

let mainWindow = null;
let setupWindow = null;
let tray = null;
let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')));
    }
  } catch {}
  if (!BUILTIN_SKINS[config.skin] && config.skin !== 'custom') config.skin = 'octopus';
}

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

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

function createPetWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const petSize = config.petSize;
  const startX = config.idleX >= 0 ? config.idleX : width - petSize - 40;
  const startY = config.idleY >= 0 ? config.idleY : height - petSize - 20;

  mainWindow = new BrowserWindow({
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

  mainWindow.setAlwaysOnTop(true, 'floating');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.loadFile(path.join(__dirname, 'pet.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('config', {
      dashboardUrl: config.dashboardUrl,
      sessionToken: config.sessionToken,
      apiKey: config.apiKey,
      skinImages: loadSkinImages(),
    });
  });

  mainWindow.on('moved', () => {
    const [x, y] = mainWindow.getPosition();
    config.idleX = x;
    config.idleY = y;
    saveConfig();
  });
}

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
    createPetWindow();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

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

function setSkin(skin) {
  config.skin = skin;
  saveConfig();
  applySkin();
  rebuildTrayMenu();
}

function chooseCustomSkinDir() {
  const result = dialog.showOpenDialogSync({
    title: 'Choose Skin Folder',
    message: 'Pick a folder containing idle / busy / thinking / stuck / offline images (png, gif, webp or jpg). Optional: waiting.',
    properties: ['openDirectory'],
  });
  if (!result || !result[0]) return;

  const dir = result[0];
  const missing = validateSkinDir(dir);
  if (missing.length > 0) {
    dialog.showErrorBox(
      'Invalid Skin Folder',
      `Missing images: ${missing.map((s) => s + '.png').join(', ')}\n\nThe folder must contain one image per state, named idle / busy / thinking / stuck / offline (extensions: png, gif, webp, jpg).`
    );
    return;
  }

  config.customSkinDir = dir;
  setSkin('custom');
}

function rebuildTrayMenu() {
  if (!tray) return;

  const skinMenu = [
    { label: 'Octopus (built-in)', type: 'radio', checked: config.skin === 'octopus', click: () => setSkin('octopus') },
  ];
  if (config.customSkinDir) {
    skinMenu.push({
      label: `Custom (${path.basename(config.customSkinDir)})`,
      type: 'radio',
      checked: config.skin === 'custom',
      click: () => setSkin('custom'),
    });
  }
  skinMenu.push({ type: 'separator' });
  skinMenu.push({ label: 'Choose Custom Folder…', click: () => chooseCustomSkinDir() });

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Luna Pet v0.3.0', enabled: false },
    { type: 'separator' },
    {
      label: 'Show / Hide',
      click: () => {
        if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
        else if (mainWindow) mainWindow.show();
      },
    },
    { label: 'Skin', submenu: skinMenu },
    {
      label: 'Settings',
      click: () => showSetup(),
    },
    {
      label: 'Reset Position',
      click: () => {
        if (!mainWindow) return;
        const display = screen.getPrimaryDisplay();
        const { width, height } = display.workAreaSize;
        mainWindow.setPosition(width - config.petSize - 40, height - config.petSize - 20);
        config.idleX = -1;
        config.idleY = -1;
        saveConfig();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
}

app.whenReady().then(() => {
  loadConfig();
  createTray();

  if (config.apiKey && config.sessionToken) {
    createPetWindow();
  } else {
    showSetup();
  }
});

app.on('window-all-closed', (e) => e.preventDefault());
