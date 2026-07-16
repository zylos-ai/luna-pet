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
};

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

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Luna Pet v0.1.0', enabled: false },
    { type: 'separator' },
    {
      label: 'Show / Hide',
      click: () => {
        if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
        else if (mainWindow) mainWindow.show();
      },
    },
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
