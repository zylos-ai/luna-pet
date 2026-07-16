// Smoke test: load main.js with stubbed electron, drive SSE events, verify behavior.
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-pet-test-'));

class FakeWebContents {
  constructor() { this.sent = []; this.handlers = {}; }
  on(ev, fn) { this.handlers[ev] = fn; }
  send(ch, data) { this.sent.push([ch, data]); }
  fireLoad() { if (this.handlers['did-finish-load']) this.handlers['did-finish-load'](); }
}
class FakeWindow {
  constructor(opts) {
    this.opts = opts; this.webContents = new FakeWebContents();
    this.destroyed = false; this.closed = false; this.handlers = {};
    FakeWindow.instances.push(this);
  }
  setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {}
  loadFile(f) { this.file = f; }
  on(ev, fn) { this.handlers[ev] = fn; }
  isDestroyed() { return this.destroyed; }
  close() { this.closed = true; this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  show() {} focus() {} getPosition() { return [1, 2]; }
  isVisible() { return true; }
}
FakeWindow.instances = [];

const ipcHandlers = { handle: {}, on: {} };
const electronStub = {
  app: {
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    quit: () => {},
    getPath: () => TMP,
    commandLine: { appendSwitch: () => {} },
  },
  BrowserWindow: FakeWindow,
  Tray: class { setToolTip() {} setContextMenu() {} },
  Menu: { buildFromTemplate: (t) => t },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  nativeImage: {
    createFromPath: () => ({ resize: () => ({}) }),
    createEmpty: () => ({}),
  },
  ipcMain: {
    handle: (ch, fn) => { ipcHandlers.handle[ch] = fn; },
    on: (ch, fn) => { ipcHandlers.on[ch] = fn; },
  },
  dialog: { showOpenDialogSync: () => null, showErrorBox: () => {} },
};

// pre-seed a legacy v0.3 config to test migration
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
  dashboardUrl: 'https://luna.jinglever.com',
  apiKey: 'zylos_ak_test',
  sessionToken: 'zylos_st_test',
  petSize: 120,
  idleX: 100,
  idleY: 200,
  skin: 'custom',
  customSkinDir: '/Users/howard/skins/luna',
}));

const src = fs.readFileSync(path.join(REPO, 'src/main.js'), 'utf8');
const tail = `
;return { loadConfig, saveConfig, petConfig, handleSSEEvent, mapAgentState, syncPetWindows,
  loadSkinImagesFrom, validateSkinDir,
  getConfig: () => config, getFleet: () => fleetAgents, getPets: () => petWindows,
  getSelfName: () => selfName, setConnected, workbenchData, ipcHandlers: null };
`;
const factory = new Function('require', '__dirname', src + tail);
const fakeRequire = (m) => (m === 'electron' ? electronStub : require(m));
const api = factory(fakeRequire, path.join(REPO, 'src'));

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
  if (!cond) failures++;
}

// 1. config migration
api.loadConfig();
const cfg = api.getConfig();
check('legacy fields removed', cfg.skin === undefined && cfg.idleX === undefined);
check('legacyPet captured', cfg.legacyPet && cfg.legacyPet.skin === 'custom' && cfg.legacyPet.x === 100);

// 2. connected + fleet event creates self pet with migrated config
api.setConnected(true);
api.handleSSEEvent('fleet', JSON.stringify({
  agents: [
    { name: 'Luna', state: 'BUSY', self: true, activity: 'reviewing PR', context_pct: 42, color: '#14b8a6' },
    { name: 'Jinglever', state: 'IDLE', activity: null, context_pct: 10, color: '#f59e0b' },
    { name: 'zylos0t', state: 'OFFLINE', activity: null, color: '#8b5cf6' },
  ],
}));
check('selfName detected', api.getSelfName() === 'Luna');
check('self pet window created', api.getPets().has('Luna'));
check('remote pets hidden by default', !api.getPets().has('Jinglever') && !api.getPets().has('zylos0t'));
const lunaPc = api.getConfig().pets['Luna'];
check('legacyPet applied to self', lunaPc.skin === 'custom' && lunaPc.x === 100 && lunaPc.visible === true);
check('legacyPet consumed', api.getConfig().legacyPet === undefined);

// 3. self rich state mapping via fleet_state
api.handleSSEEvent('fleet_state', JSON.stringify({
  state: 'BUSY', running_tools: [{ tool_name: 'Bash', tool_detail: 'npm test' }],
  context_pct: 65, agent: { name: 'Luna' },
  last_message: { text: '好的，我开始处理这个任务。' },
  active_subagents: [{ agent_id: 'a1' }, { agent_id: 'a2' }],
}));
let mapped = api.mapAgentState('Luna');
check('self busy w/ tool label (workbench)', mapped.stateKey === 'busy' && mapped.label.startsWith('Bash'));
check('context passthrough', mapped.contextPct === 65);
check('bubble = last reply even while busy', mapped.bubble === '好的，我开始处理这个任务。');
check('subCount from active_subagents', mapped.subCount === 2 && mapped.hasSubs === true);

// thinking: BUSY with no tools — reason must NOT be surfaced (its (Ns) is turn age)
api.handleSSEEvent('state_change', JSON.stringify({
  state: 'BUSY', running_tools: [], reason: 'Thinking (70s)', agent: { name: 'Luna' },
  last_message: { text: '好的，我开始处理这个任务。' },
}));
mapped = api.mapAgentState('Luna');
check('thinking label is plain, no stale reason', mapped.stateKey === 'thinking' && mapped.label === 'Thinking...');
check('thinking bubble still last reply', mapped.bubble === '好的，我开始处理这个任务。');
check('no subagents -> hasSubs false', mapped.subCount === 0 && mapped.hasSubs === false);

// waiting state
api.handleSSEEvent('state_change', JSON.stringify({
  state: 'BUSY', running_tools: [], source: { pending_permission: true }, agent: { name: 'Luna' },
}));
mapped = api.mapAgentState('Luna');
check('self waiting', mapped.stateKey === 'waiting');

// 4. remote mapping (no rich data)
mapped = api.mapAgentState('Jinglever');
check('remote idle label = name', mapped.stateKey === 'idle' && mapped.label === 'Jinglever');
check('remote bubble empty (no speech data)', mapped.bubble === '');
mapped = api.mapAgentState('zylos0t');
check('remote offline', mapped.stateKey === 'offline');

// remote has_subagent bool -> hasSubs dot without count
api.handleSSEEvent('fleet', JSON.stringify({
  agents: [
    { name: 'Luna', state: 'BUSY', self: true },
    { name: 'Jinglever', state: 'BUSY', has_subagent: true },
    { name: 'zylos0t', state: 'OFFLINE' },
  ],
}));
mapped = api.mapAgentState('Jinglever');
check('remote has_subagent -> hasSubs, no count', mapped.hasSubs === true && mapped.subCount === 0);

// 5. workbench toggles remote visible -> window created
ipcHandlers.on['wb-set-visible'](null, { name: 'Jinglever', visible: true });
check('remote pet window created on toggle', api.getPets().has('Jinglever'));
ipcHandlers.on['wb-set-visible'](null, { name: 'Jinglever', visible: false });
check('remote pet window closed on untoggle', !api.getPets().has('Jinglever'));

// 6. pet window init payload (skins + sounds) on load
const lunaWin = api.getPets().get('Luna');
lunaWin.webContents.fireLoad();
const initMsg = lunaWin.webContents.sent.find(([ch]) => ch === 'init');
check('init sent with skin images', initMsg && initMsg[1].skinImages && !!initMsg[1].skinImages.idle);
check('skin states are frame lists', Array.isArray(initMsg[1].skinImages.idle.frames) && initMsg[1].skinImages.idle.fps > 0);
check('custom skin fell back to octopus (dir missing)', initMsg[1].skinImages.idle.frames[0].startsWith('data:image/png'));

// frame-sequence skin folder: idle-1/idle-2 + singles for the rest + skin.json
const seqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-skin-seq-'));
const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
for (const f of ['idle-1.png','idle-2.png','busy.png','thinking.png','stuck.png','offline.png']) fs.writeFileSync(path.join(seqDir, f), px);
fs.writeFileSync(path.join(seqDir, 'skin.json'), JSON.stringify({ fps: 6, states: { busy: 12 } }));
check('frame-seq dir validates', api.validateSkinDir(seqDir).length === 0);
const seqSkin = api.loadSkinImagesFrom(seqDir);
check('idle sequence has 2 frames @6fps', seqSkin.idle.frames.length === 2 && seqSkin.idle.fps === 6);
check('per-state fps override', seqSkin.busy.fps === 12 && seqSkin.busy.frames.length === 1);
check('waiting falls back to idle frames', seqSkin.waiting.frames.length === 2);
check('custom skin gets no tint', initMsg[1].tint === null);
check('octopus skin gets numeric tint (workbench data)', (() => {
  const wb0 = api.workbenchData();
  const jing = wb0.agents.find(a => a.name === 'Jinglever');
  return jing && jing.skin === 'octopus';
})());
// state messages carry tint + hue matches dashboard fnv1a semantics
const stateMsg = lunaWin.webContents.sent.filter(([ch]) => ch === 'state').pop();
check('state carries tint field', stateMsg && 'tint' in stateMsg[1]);
check('state carries since timestamp', stateMsg && typeof stateMsg[1].since === 'number');
check('state carries bubble + subagent fields', stateMsg && 'bubble' in stateMsg[1] && 'subCount' in stateMsg[1] && 'hasSubs' in stateMsg[1]);

// sound cues: drive Luna busy -> idle with sound on, expect start + finish cues
const cuesSent = () => lunaWin.webContents.sent.filter(([ch]) => ch === 'play-cue').map(([, c]) => c);
api.handleSSEEvent('state_change', JSON.stringify({ state: 'IDLE', agent: { name: 'Luna' } }));
const before = cuesSent().length;
api.handleSSEEvent('state_change', JSON.stringify({ state: 'BUSY', running_tools: [{ tool_name: 'Bash' }], agent: { name: 'Luna' } }));
check('start cue on idle->busy', cuesSent().includes('start'));
api.handleSSEEvent('state_change', JSON.stringify({ state: 'IDLE', agent: { name: 'Luna' } }));
check('finish cue on busy->idle', cuesSent().includes('finish'));

// 6b. idle self surfaces last assistant reply as label
api.handleSSEEvent('state_change', JSON.stringify({ state: 'IDLE', last_message: { text: '数据库已经更新完成，测试全部通过。'.repeat(3) }, agent: { name: 'Luna' } }));
const idleMapped = api.mapAgentState('Luna');
check('idle label = last reply text', idleMapped.label.startsWith('数据库已经更新完成'));
check('label capped at 320 chars', idleMapped.label.length <= 320);

// 7. workbench data shape
const wb = api.workbenchData();
check('workbench lists 3 agents, self first', wb.agents.length === 3 && wb.agents[0].name === 'Luna' && wb.agents[0].self === true);
check('workbench connected flag', wb.connected === true);

// 8. agent removed from fleet -> window closed
api.handleSSEEvent('fleet', JSON.stringify({
  agents: [{ name: 'Luna', state: 'IDLE', self: true }],
}));
check('fleet prune closes stale windows', api.getPets().size === 1 && api.getPets().has('Luna'));

// 9. sound toggle: muted -> transitions emit no cues
ipcHandlers.on['wb-set-sound'](null, { enabled: false });
check('sound disabled in config', api.getConfig().soundEnabled === false);
const cueCountMuted = lunaWin.webContents.sent.filter(([ch]) => ch === 'play-cue').length;
api.handleSSEEvent('state_change', JSON.stringify({ state: 'BUSY', running_tools: [{ tool_name: 'Bash' }], agent: { name: 'Luna' } }));
api.handleSSEEvent('state_change', JSON.stringify({ state: 'IDLE', agent: { name: 'Luna' } }));
check('no cues while muted', lunaWin.webContents.sent.filter(([ch]) => ch === 'play-cue').length === cueCountMuted);

// 10. keepKey settings path (no network — expect graceful error, not crash)
ipcHandlers.handle['wb-save-settings'](null, { dashboardUrl: '', apiKey: '', keepKey: false })
  .then((r) => {
    check('empty key rejected gracefully', r.ok === false);
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
    process.exit(failures === 0 ? 0 : 1);
  });
