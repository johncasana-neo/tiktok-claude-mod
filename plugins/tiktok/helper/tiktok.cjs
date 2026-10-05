// TikTok helper: a Chrome app window on TikTok, driven over CDP. No dependencies, Node 22+ (global WebSocket).
// Run: node tiktok.cjs <profile dir> <play|pause> [login]   (login: a plain window to sign in, no control server)
// Listens on 127.0.0.1:48731 for POST /join, /play, /pause, /leave (all take ?s=<session id>), /next, /prev, /mute (toggle), /quit
// and GET /state. Every request must carry the x-tiktok-mod header.
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const { spawn } = require('node:child_process')

const [profile, initial = 'pause', mode = 'pane'] = process.argv.slice(2)
const CTL = Number(process.env.TIKTOK_PORT) || 48731 // the mod talks to 48731; the env var is for tests
const START = 'https://www.tiktok.com/foryou'
const WIDTH = 460
const LEASE_MS = Number(process.env.TIKTOK_LEASE_MS) || 90000 // a session that stops saying hello (it sends one every 30s) is forgotten
const IDLE_MS = 60000 // with nobody left for this long, the window closes
const sleep = ms => new Promise(r => setTimeout(r, ms))

function findChrome() {
  const e = process.env
  const roots = [e.PROGRAMFILES, e['PROGRAMFILES(X86)'], e.LOCALAPPDATA].filter(Boolean)
  const rel = ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']
  const paths = [e.CHROME_PATH, ...rel.flatMap(r => roots.map(d => `${d}/${r}`))]
  return paths.find(p => p && fs.existsSync(p))
}

// Runs in every page: while paused, any video that starts is paused again (TikTok autoplays the next one),
// unless the person just clicked: a click to play is theirs.
const GUARD = `
  window.__claude = window.__claude || { paused: ${initial === 'pause'}, click: 0, muted: false }
  addEventListener('pointerdown', () => { window.__claude.click = Date.now() }, true)
  document.addEventListener('play', e => {
    const c = window.__claude
    if (!(e.target instanceof HTMLMediaElement)) return
    if (c.muted) e.target.muted = true // every video that starts inherits /tiktok mute
    if (c.paused && Date.now() - c.click > 1500) e.target.pause()
  }, true)
`

const SET_PAUSED = paused => `(() => {
  window.__claude = window.__claude || {}
  window.__claude.paused = ${paused}
  if (${paused}) return document.querySelectorAll('video').forEach(v => v.pause())
  const v = [...document.querySelectorAll('video')].find(x => {
    const r = x.getBoundingClientRect()
    return r.top < innerHeight && r.bottom > 0 && r.width > 0
  })
  if (v) v.play().catch(() => {})
})()`

// Whether the control port is free, checked before any window opens.
const portFree = () =>
  new Promise(done => {
    const probe = net.createServer().once('error', () => done(false))
    probe.listen(CTL, '127.0.0.1', () => probe.close(() => done(true)))
  })

let chromeProc // closed if anything below fails, so no window is left behind

async function main() {
  // Each message below is what the person sees in Claude Code, so it says what to do.
  if (typeof WebSocket !== 'function') throw new Error(`TikTok needs Node 22 or newer; this is Node ${process.version}`)
  const chrome = findChrome()
  if (!chrome) throw new Error('TikTok needs Chrome or Edge; if one is installed somewhere unusual, set CHROME_PATH to its .exe')
  fs.mkdirSync(profile, { recursive: true })

  if (mode === 'login') {
    // A plain Chrome on the same profile: no debugging port, no control server, nothing scripted about it.
    // Log in, close the window, then /tiktok picks the session up from the profile.
    await sleep(1500) // a window that was just stopped may still hold the profile
    const login = spawn(chrome, [`--app=https://www.tiktok.com/login`, `--user-data-dir=${profile}`, `--window-size=${WIDTH},860`, '--no-first-run', '--no-default-browser-check'], { stdio: 'ignore' })
    login.on('exit', () => process.exit(0))
    return
  }

  if (!(await portFree())) throw new Error(`TikTok cannot start: port ${CTL} is used by another program`)
  const portFile = `${profile}/DevToolsActivePort`
  fs.rmSync(portFile, { force: true }) // Chrome picks a free debugging port and writes it here
  const proc = (chromeProc = spawn(
    chrome,
    [
      `--app=${START}`,
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      `--window-size=${WIDTH},860`,
      '--autoplay-policy=no-user-gesture-required',
      // The window sits behind Claude's terminal: keep Chrome from treating it as hidden and freezing the video.
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    { stdio: 'ignore' },
  ))
  proc.on('exit', () => process.exit(0)) // the person closed the window

  // Wait for the page target, then talk CDP over its websocket.
  let target
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200)
    try {
      const cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0]
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
    } catch {}
  }
  if (!target) throw new Error('Chrome did not expose a page')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, no) => ((ws.onopen = ok), (ws.onerror = no)))
  let id = 0
  const pending = new Map()
  ws.onmessage = m => {
    const d = JSON.parse(m.data)
    pending.get(d.id)?.(d)
    pending.delete(d.id)
  }
  const cdp = (method, params = {}) =>
    new Promise(r => {
      pending.set(++id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const run = expression => cdp('Runtime.evaluate', { expression, returnByValue: true })

  let paused = initial === 'pause'
  let muted = false
  // Several Claude Code sessions can share this window: it plays while any of them works.
  const members = new Map() // session id -> { last: ms of its last message, working }
  let emptySince = Date.now()
  const touch = sid => {
    let m = members.get(sid)
    if (!m) members.set(sid, (m = { last: 0, working: false }))
    m.last = Date.now()
    return m
  }
  const settle = async () => {
    paused = ![...members.values()].some(m => m.working)
    await run(SET_PAUSED(paused))
  }
  await cdp('Page.enable')
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }) // the window never has real focus: Claude's terminal does
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: GUARD })
  await run(GUARD)
  await run(SET_PAUSED(paused))

  // Dock the window to the right edge of the screen, full height, like a side panel.
  const screen = (await run('({ l: screen.availLeft, t: screen.availTop, w: screen.availWidth, h: screen.availHeight })')).result?.result?.value
  const win = (await cdp('Browser.getWindowForTarget', { targetId: target.id })).result
  if (screen && win) {
    await cdp('Browser.setWindowBounds', { windowId: win.windowId, bounds: { left: screen.l + screen.w - WIDTH, top: screen.t, width: WIDTH, height: screen.h } })
  }

  // The video nearest the middle of the window, by its source.
  const current = async () =>
    (await run(`(() => { let best = '', d = 1e9; for (const v of document.querySelectorAll('video')) { const r = v.getBoundingClientRect(); if (r.height < 150) continue; const dist = Math.abs(r.top + r.height / 2 - innerHeight / 2); if (dist < d) { d = dist; best = v.currentSrc } } return best })()`)).result?.result?.value

  // Next (dir 1) or previous (-1) video: the arrow key first, scrolling the feed itself when the key changed nothing.
  const move = async dir => {
    // Signed out, TikTok shows a login dialog after a few videos and it blocks scrolling until closed.
    await run(`document.querySelector('[data-e2e=modal-close-inner-button]')?.click()`)
    await sleep(300)
    const before = await current()
    const k = dir > 0 ? 'ArrowDown' : 'ArrowUp'
    const p = { key: k, code: k, windowsVirtualKeyCode: dir > 0 ? 40 : 38 }
    await run('document.activeElement?.blur?.()') // a focused TikTok button (after a login click) swallows the arrow keys
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...p })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...p })
    await sleep(900)
    if ((await current()) === before) {
      // A modal (login, "pick your interests") can swallow keys and wheel alike: scroll the feed container itself.
      await run(`(() => { const sc = [...document.querySelectorAll('div')].filter(e => e.clientHeight > 300 && e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible' && e.querySelector('video')).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]; if (sc) sc.scrollBy({ top: ${dir} * sc.clientHeight, behavior: 'instant' }) })()`)
      await sleep(700)
    }
    await run(SET_PAUSED(paused))
  }

  const shutdown = async () => {
    await cdp('Browser.close').catch(() => {})
    proc.kill()
    process.exit(0)
  }

  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, 'http://tiktok')
      const path = url.pathname
      const sid = url.searchParams.get('s') ?? ''
      // Only the mod drives this. A web page cannot add the custom header (that takes a preflight this server never
      // answers), nor pass the Host check (DNS rebinding).
      if (!req.headers['x-tiktok-mod'] || !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) {
        res.statusCode = 403
        return res.end('forbidden')
      }
      try {
        if (path === '/join') touch(sid)
        else if (path === '/play' || path === '/pause') {
          touch(sid).working = path === '/play'
          await settle()
        } else if (path === '/leave') {
          const was = members.delete(sid)
          if (was && members.size === 0) return res.end('bye'), shutdown() // the last session is gone
          if (was) await settle()
        } else if (path === '/next') await move(1)
        else if (path === '/prev') await move(-1)
        else if (path === '/mute') {
          muted = !muted
          await run(`window.__claude.muted = ${muted}; document.querySelectorAll('video').forEach(v => { v.muted = ${muted} })`)
          return res.end(muted ? 'muted' : 'unmuted')
        } else if (path === '/quit') return res.end('bye'), shutdown()
        else if (path === '/state') {
          const v = await run(`[...document.querySelectorAll('video')].map(v => { const r = v.getBoundingClientRect(); return { paused: v.paused, t: Math.round(v.currentTime * 10) / 10, top: Math.round(r.top), h: Math.round(r.height), src: v.currentSrc.slice(-12) } })`)
          const working = [...members.values()].filter(m => m.working).length
          return res.end(JSON.stringify({ paused, muted, sessions: members.size, working, videos: v.result?.result?.value }))
        }
        res.end(paused ? 'paused' : 'playing')
      } catch (err) {
        res.statusCode = 500
        res.end(String(err))
      }
    })
    .on('error', err => {
      console.error(`TikTok cannot start: port ${CTL}: ${err.message}`) // taken in the moment since the check above
      shutdown()
    })
    .listen(CTL, '127.0.0.1', () => console.log('R ready'))
  // Forget sessions that went quiet (crashed, or reloaded under a new id), and close when nobody is left.
  setInterval(() => {
    const now = Date.now()
    let changed = false
    for (const [sid, m] of members) {
      if (now - m.last > LEASE_MS) changed = members.delete(sid) || changed
    }
    if (changed) settle().catch(() => {}) // the forgotten session may have been the only one still "working"
    if (members.size) emptySince = now
    else if (now - emptySince > IDLE_MS) shutdown()
  }, 5000)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch(err => {
  console.error(err.message)
  chromeProc?.kill()
  process.exit(1)
})
