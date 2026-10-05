// TikTok: a Chrome window on tiktok.com, driven by helper/tiktok.cjs.
// It plays while Claude works and pauses when Claude is done. Nothing starts until /tiktok.
import type { EngineInterface, Register } from 'claude-code'

const CTL = 'http://127.0.0.1:48731'
// A turn must last this long before the video starts, so a two-second answer never flashes it on and off.
const PLAY_DELAY_MS = 4000
// The helper forgets a session that stays silent for 90s, so this one says hello well inside that.
const HELLO_MS = 30000

// This session's name for the helper, which counts the sessions sharing its window: it plays while any of them works.
const SESSION = Math.random().toString(36).slice(2, 10)

const HELP = [
  '/tiktok            open TikTok; it plays while Claude works',
  '/tiktok next|prev  change video',
  '/tiktok mute       turn the sound off or on',
  '/tiktok status     what is running',
  '/tiktok restart    close the window and open it again',
  '/tiktok login      a plain window to sign in',
  '/tiktok stop       close it, for every session using it',
  '/tiktok help       this list',
].join('\n')

// Whether /tiktok was run in this session. Only then do its turns drive the window; a reload starts it over.
let isOn = false
// Whether Claude is working; a reload starts it over.
let isWorking = false
// Whether the video actually played during this turn: only then does its end deserve a toast.
let hasPlayed = false
// The pending "start playing" of the current turn; cancelled when the turn ends first.
let playTimer: { cancel(): void } | undefined
// The periodic hello that keeps this session on the helper's list.
let hello: { cancel(): void } | undefined
// Whether a helper this module spawned is still alive (set from /tiktok until it exits).
let isStarting = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command
      .register({ name: 'tiktok', description: 'Play TikTok in a window while Claude works; /tiktok help lists the options' })
      .catch(() => {})
    return r
  })

  on('command.run', { command: 'tiktok' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'stop') {
      await send($, '/quit') // for every session sharing the window
      isOn = false
      hello?.cancel()
      hello = undefined
      await $.ui.status(undefined)
      return { text: 'TikTok stopped.' }
    }
    if (arg === 'login') {
      await send($, '/quit') // the profile opens in one Chrome at a time
      for (let i = 0; i < 20 && isStarting; i++) await $.clock.sleep(250)
      if (!(await start($, 'login'))) return { text: 'TikTok is still closing: try /tiktok login again in a few seconds.' }
      return { text: 'A plain TikTok window opened to log in (nothing scripted). Log in, close it, then run /tiktok.' }
    }
    if (arg === 'mute') {
      const state = await ask($, '/mute')
      return { text: state ? `TikTok: ${state}.` : 'TikTok is not running: run /tiktok.' }
    }
    if (arg === 'next' || arg === 'prev') {
      return { text: (await send($, `/${arg}`)) ? `TikTok: ${arg}.` : 'TikTok is not running: run /tiktok.' }
    }
    if (arg === 'help') return { text: HELP }
    if (arg === 'status') return { text: await describe($) }
    if (arg === 'restart') {
      await send($, '/quit')
      for (let i = 0; i < 20 && isStarting; i++) await $.clock.sleep(250)
      if (isStarting) return { text: 'TikTok is still closing: try /tiktok restart again in a few seconds.' }
      await $.clock.sleep(1000) // Chrome may still hold the profile for a moment
      await open($)
      return { text: 'TikTok restarted.' }
    }
    if (arg !== '') return { text: `Unknown option "${arg}".\n${HELP}` } // a typo must not open anything
    await open($)
    return { text: 'TikTok is on. It plays while Claude works. First time: log in or dismiss prompts in its window.' }
  })

  on('turn.start', async ($, e, next) => {
    isWorking = true
    if (isOn) {
      playTimer?.cancel()
      playTimer = $.clock.after(PLAY_DELAY_MS, () => {
        if (!isWorking) return
        void send($, mine('/play'))
          .then(ok => {
            if (!ok) return
            hasPlayed = true
            return $.ui.status('▶ TikTok')
          })
          .catch(() => {})
      })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      isWorking = false
      playTimer?.cancel()
      playTimer = undefined
      // The helper pauses only when no other session is still working.
      if (isOn && (await send($, mine('/pause')))) {
        await $.ui.status('⏸ TikTok')
        if (hasPlayed) await $.ui.toast('Claude is done: TikTok paused', { timeoutMs: 6000 })
      }
      hasPlayed = false
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    // After /clear or a resume this process and module go on under another session id: stay on the helper's list.
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      hello?.cancel()
      hello = undefined
      // Leaving closes the window only when this was the last session using it.
      if (isOn) await send($, mine('/leave'))
    }
    return next(e)
  })
}

// Puts this session in charge of the window: opens it, or joins the one already open.
async function open($: EngineInterface) {
  isOn = true
  hello ??= $.clock.every(HELLO_MS, () => void send($, mine('/join')))
  if (!(await send($, '/state'))) await start($)
  else {
    await send($, mine('/join'))
    if (isWorking) await send($, mine('/play'))
  }
  if (isWorking) hasPlayed = true // opened mid-turn: it plays right away
}

// What /tiktok status prints.
async function describe($: EngineInterface) {
  const raw = await ask($, '/state')
  if (raw === undefined) return 'TikTok is not running. Run /tiktok to open it.'
  let s: { paused?: boolean; muted?: boolean; sessions?: number; working?: number } = {}
  try {
    s = JSON.parse(raw)
  } catch {}
  const n = s.sessions ?? 0
  return [
    `TikTok is ${s.paused ? 'paused' : 'playing'}, sound ${s.muted ? 'off' : 'on'}.`,
    `${n} session${n === 1 ? '' : 's'} using the window, ${s.working ?? 0} working.`,
    isOn ? 'This session drives it.' : 'This session does not drive it: run /tiktok here to join.',
  ].join('\n')
}

// Returns false when a helper is already starting or running.
async function start($: EngineInterface, mode?: 'login') {
  if (isStarting) return false // a second /tiktok before the helper answers would open a second window
  isStarting = true
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const profile = `${home}/.claude-mods/tiktok/profile`
  // Said when the helper dies without a word of its own, typically `node` missing from PATH.
  const silentFailure = 'tiktok: the helper did not start. TikTok needs Node 22 or newer on PATH (try `node -v`).'
  let isReady = false
  let hasSaid = false
  // A child for the session's life: the loop ends with the helper or with this module.
  void (async () => {
    const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/helper/tiktok.cjs`, profile, isWorking ? 'play' : 'pause', ...(mode ? [mode] : [])] })
    for await (const piece of child) {
      if (!('stream' in piece)) continue
      if (piece.stream === 'stdout' && piece.text.includes('R ready')) isReady = true
      if (piece.stream === 'stderr') {
        hasSaid = true
        await $.ui.toast(`tiktok: ${piece.text.trim()}`)
        $.ui.log(piece.text, { to: 'debug' })
      }
    }
    // The login window prints nothing and is fine; the player should have said it was ready.
    if (!mode && !isReady && !hasSaid) await $.ui.toast(silentFailure)
    await $.ui.status(undefined)
  })()
    .catch(async err => {
      $.ui.log(`tiktok: helper did not start: ${String(err)}`, { to: 'debug' })
      if (!hasSaid) await $.ui.toast(silentFailure) // the helper's own reason, when it gave one, is the better message
    })
    .finally(() => (isStarting = false))
  return true
}

// A path that says which session is speaking.
function mine(path: string) {
  return `${path}?s=${SESSION}`
}

// Sends one command to the helper and returns its answer; undefined when it is not running.
// The custom header is the helper's lock: a web page cannot add it, so only this module gets in.
async function ask($: EngineInterface, path: string) {
  try {
    const r = await $.http.fetch(`${CTL}${path}`, { method: path.startsWith('/state') ? 'GET' : 'POST', headers: { 'x-tiktok-mod': '1' } })
    return r.ok ? r.text : undefined
  } catch {
    return undefined
  }
}

async function send($: EngineInterface, path: string) {
  return (await ask($, path)) !== undefined
}
