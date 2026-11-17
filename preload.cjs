// The only bridge between the window and the main process: a fixed list of
// calls the page may make, and two streams of events it may listen to.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const CALLS = new Set([
  'state:load',
  'project:add',
  'project:remove',
  'project:transcript',
  'project:send',
  'project:stop',
  'project:new',
  'project:another',
  'project:describe',
  'project:mode',
  'project:permission',
  'project:branch',
  'queue:remove',
  'queue:now',
  'session:info',
  'session:usage',
  'session:context',
  'session:commands',
  'session:servers',
  'session:model',
  'session:effort',
  'session:fast',
  'mcp:reconnect',
  'mcp:toggle',
  'mcp:authorize',
  'plugins:list',
  'plugins:toggle',
  'skins:list',
  'skins:use',
  'skins:import',
  'skins:folder',
  'app:reload',
  'music:cover',
  'dictate:start',
  'dictate:stop',
  'player:which',
  'player:browser',
  'player:state',
  'claude:open',
  'window:glass',
  'skins:link', 'themes:list',
  'themes:save',
  'themes:delete',
  'themes:export',
  'themes:import',
  'today:stats',
  'music:bytes',
  'look:get',
  'look:set',
  'look:picture',
  'about:info',
  'docs:open',
  'docs:read',
  'settings:read',
  'settings:open',
  'settings:web',
  'video:find',
  'outside:state',
  'player:hide',
  'spotify:open',
  'app:restart',
  'auth:status',
  'auth:login',
  'sessions:list',
  'sessions:open',
  'chats:all',
  'chats:open',
  'chats:archive',
  'chats:delete',
  'chats:fork',
  'text:copy',
  'win',
  'win:least',
  'win:flash',
  'task:stop',
  'work:load',
  'pick:video',
  'file:view',
  'file:reveal',
  'file:browser',
  'pages:toggle',
  'attach:pick',
  'attach:paste',
  'music:add',
  'music:remove',
  'music:playlist',
  'music:unlist',
  'zoom:set',
  'agent:read',
  'awake:set',
  'music:scan',
  'deck:cmd',
  'prefs:set',
])
const STREAMS = new Set(['amp:event', 'amp:deck', 'amp:update', 'amp:dictate', 'amp:player', 'amp:outside', 'amp:docked'])

contextBridge.exposeInMainWorld('amp', {
  call: (name, ...args) => {
    if (!CALLS.has(name)) {
      throw new Error(`Unknown call ${name}`)
    }

    return ipcRenderer.invoke(name, ...args)
  },
  on: (name, listener) => {
    if (!STREAMS.has(name)) {
      throw new Error(`Unknown stream ${name}`)
    }

    ipcRenderer.on(name, (_event, payload) => listener(payload))
  },
  // Where a file dropped on the window lives on this computer ('' for one with no file behind it).
  pathOf: file => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
})
