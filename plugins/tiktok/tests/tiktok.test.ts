import { describe, expect, test } from 'claude-code/testing'

const wait = (ms: number) => new Promise(done => (globalThis as any).setTimeout(done, ms))
const until = async (check: () => unknown) => {
  for (let i = 0; i < 200 && !check(); i++) await wait(5)
}

// Stands for the engine beneath the mod: a home folder, a fake helper and its control port.
// `delayHeld`: the "start playing" timer waits until `release()`, as a turn that has not yet lasted long enough.
// `running`: a helper is already up, started by some other session.
// `spawn`: how the helper fails to start, if it does: node missing, dying silently, or dying with its own message.
function engine(on: any, opts: { delayHeld?: boolean; running?: boolean; spawn?: 'missing' | 'silent' | string } = {}) {
  const sent: string[] = []
  const seen: { path: string; s: string | null; locked: boolean }[] = []
  const spawned: string[][] = []
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  let running = !!opts.running
  let release = () => {}
  const gate = opts.delayHeld ? new Promise<void>(done => (release = done)) : Promise.resolve()
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: undefined }))
  on('env.get', () => ({ value: 'C:/Users/me' }))
  on('ui.status', (_$: any, e: any) => (status.push(e.text), { value: undefined }))
  on('ui.toast', (_$: any, e: any) => (toasts.push(e.text), { value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('clock.after', async () => (await gate, { value: undefined }))
  on('clock.sleep', async (_$: any, e: any) => (await wait(Math.min(e.ms, 10)), { value: undefined })) // waits are short in tests
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('http.fetch', (_$: any, e: any) => {
    const url = new URL(e.url)
    sent.push(url.pathname)
    seen.push({ path: url.pathname, s: url.searchParams.get('s'), locked: e.init?.headers?.['x-tiktok-mod'] === '1' })
    if (!running) throw new Error('ECONNREFUSED')
    if (url.pathname === '/quit') running = false
    const text =
      url.pathname === '/mute' ? 'muted' : url.pathname === '/state' ? JSON.stringify({ paused: true, muted: false, sessions: 2, working: 1 }) : 'ok'
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('process.spawn', async function* (_$: any, e: any) {
    spawned.push(e.argv)
    if (opts.spawn === 'missing') throw new Error('spawn node ENOENT')
    if (opts.spawn === 'silent') return { code: 1 }
    if (opts.spawn) {
      yield { stream: 'stderr', text: opts.spawn + '\n' }
      return { code: 1 }
    }
    if (e.argv.at(-1) === 'login') return { code: 0 } // a plain window: no control server
    running = true
    yield { stream: 'stdout', text: 'R ready\n' }
    while (running) await wait(5)
    return { code: 0 }
  })
  return { sent, seen, spawned, status, toasts, release }
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as any)
const turn = async ($: any, id: string) => {
  await $.turn.start({ text: 'go', turnId: id } as any)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
}

describe('tiktok', () => {
  test('nothing starts on its own: a turn without /tiktok spawns no helper', async ($, on) => {
    const h = engine(on)
    await start($)
    await turn($, 't1')
    expect(h.spawned).toEqual([])
  })

  test('a session that never ran /tiktok does not drive a window another session opened', async ($, on) => {
    const h = engine(on, { running: true })
    await start($)
    await turn($, 't1')
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's' } as any)
    expect(h.sent).toEqual([])
    expect(h.toasts).toEqual([])
  })

  test('/tiktok login opens the plain login window, and no turn tries to control it', async ($, on) => {
    const h = engine(on)
    await start($)
    const r: any = await $.command.run({ command: 'tiktok', args: 'login' } as any)
    expect(r.text).toMatch(/Log in, close it, then run \/tiktok/)
    expect(h.spawned[0]?.at(-1)).toBe('login')
    await turn($, 't1')
    expect(h.sent.filter(p => p === '/play' || p === '/pause')).toEqual([])
  })

  test('a turn that ends before the delay never plays the video', async ($, on) => {
    const h = engine(on, { delayHeld: true })
    await start($)
    await $.command.run({ command: 'tiktok', args: '' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await wait(20)
    expect(h.sent).not.toContain('/play') // the delay has not passed
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    h.release() // even if the timer fires late, the turn is over
    await wait(30)
    expect(h.sent).not.toContain('/play')
    expect(h.sent.at(-1)).toBe('/pause')
    expect(h.toasts).toEqual([]) // nothing was playing, so there is nothing to announce
    await $.command.run({ command: 'tiktok', args: 'stop' } as any)
  })

  test('a long turn plays after the delay and pauses when done; /tiktok stop ends it for everyone', async ($, on) => {
    const h = engine(on)
    await start($)
    await $.command.run({ command: 'tiktok', args: '' } as any)
    expect(h.spawned[0]?.[0]).toBe('node')
    expect(h.spawned[0]?.at(-2)).toBe('C:/Users/me/.claude-mods/tiktok/profile')

    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await until(() => h.sent.includes('/play'))
    expect(h.sent).toContain('/play')
    await until(() => h.status.at(-1) === '▶ TikTok')
    expect(h.status.at(-1)).toBe('▶ TikTok')

    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    expect(h.sent.at(-1)).toBe('/pause')
    expect(h.status.at(-1)).toBe('⏸ TikTok')
    expect(h.toasts).toHaveLength(1)
    expect(h.toasts[0]).toMatch(/Claude is done/)

    await $.turn.start({ text: 'again', turnId: 't2' } as any)
    await until(() => h.sent.filter(p => p === '/play').length === 2)
    await wait(10) // the status line follows the play
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    expect(h.toasts).toHaveLength(2) // announced once per turn that played

    await $.command.run({ command: 'tiktok', args: 'stop' } as any)
    expect(h.sent.at(-1)).toBe('/quit')
  })

  test('every request carries the lock header, and play/pause/leave say which session they come from', async ($, on) => {
    const h = engine(on)
    await start($)
    await $.command.run({ command: 'tiktok', args: '' } as any)
    await $.turn.start({ text: 'go', turnId: 't1' } as any)
    await until(() => h.sent.includes('/play'))
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 } as any)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's' } as any)
    expect(h.seen.length).toBeGreaterThan(3)
    expect(h.seen.every(r => r.locked)).toBe(true)
    const named = h.seen.filter(r => ['/play', '/pause', '/leave'].includes(r.path))
    expect(named.map(r => r.path)).toEqual(['/play', '/pause', '/leave'])
    expect(named.every(r => r.s && r.s === named[0]!.s)).toBe(true) // one id for the whole session
  })

  test('ending a session says goodbye instead of closing the window other sessions may be using', async ($, on) => {
    const h = engine(on)
    await start($)
    await $.command.run({ command: 'tiktok', args: '' } as any)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's' } as any)
    expect(h.sent).toContain('/leave')
    expect(h.sent).not.toContain('/quit')
  })

  test('a /clear ends the session id but not the process: it stays on the helper\'s list', async ($, on) => {
    const h = engine(on)
    await start($)
    await $.command.run({ command: 'tiktok', args: '' } as any)
    await $.session.end({ reason: 'clear', sessionId: 's' } as any)
    expect(h.sent).not.toContain('/leave')
    expect(h.sent).not.toContain('/quit')
    await $.command.run({ command: 'tiktok', args: 'stop' } as any)
  })

  test('/tiktok help lists the options; an unknown option shows them and opens nothing', async ($, on) => {
    const h = engine(on)
    await start($)
    const help: any = await $.command.run({ command: 'tiktok', args: 'help' } as any)
    for (const word of ['next|prev', 'mute', 'status', 'restart', 'login', 'stop']) expect(help.text).toContain(word)
    const typo: any = await $.command.run({ command: 'tiktok', args: 'nxt' } as any)
    expect(typo.text).toMatch(/Unknown option "nxt"/)
    expect(typo.text).toContain('restart')
    expect(h.spawned).toEqual([])
    expect(h.sent).toEqual([])
  })

  test('/tiktok status says what is running, and whether this session drives it', async ($, on) => {
    engine(on, { running: true })
    await start($)
    const joined: any = await $.command.run({ command: 'tiktok', args: 'status' } as any)
    expect(joined.text).toContain('paused')
    expect(joined.text).toContain('sound on')
    expect(joined.text).toContain('2 sessions using the window, 1 working')
    expect(joined.text).toContain('does not drive it') // /tiktok has not been run here
    await $.command.run({ command: 'tiktok', args: '' } as any)
    const driving: any = await $.command.run({ command: 'tiktok', args: 'status' } as any)
    expect(driving.text).toContain('This session drives it')
    await $.command.run({ command: 'tiktok', args: 'stop' } as any)
  })

  test('/tiktok status when nothing runs says how to open it', async ($, on) => {
    engine(on)
    await start($)
    const r: any = await $.command.run({ command: 'tiktok', args: 'status' } as any)
    expect(r.text).toMatch(/not running.*\/tiktok/)
  })

  test('/tiktok restart closes the window and opens a fresh one', async ($, on) => {
    const h = engine(on)
    await start($)
    await $.command.run({ command: 'tiktok', args: '' } as any)
    expect(h.spawned).toHaveLength(1)
    const r: any = await $.command.run({ command: 'tiktok', args: 'restart' } as any)
    expect(r.text).toBe('TikTok restarted.')
    expect(h.sent).toContain('/quit')
    expect(h.spawned).toHaveLength(2)
    await $.command.run({ command: 'tiktok', args: 'stop' } as any)
  })

  test('if node cannot be run, /tiktok says what is missing instead of failing silently', async ($, on) => {
    const h = engine(on, { spawn: 'missing' })
    await start($)
    await $.command.run({ command: 'tiktok', args: '' } as any)
    await until(() => h.toasts.length)
    expect(h.toasts[0]).toMatch(/Node 22 or newer on PATH/)
  })

  test('a helper that dies without a word is reported the same way', async ($, on) => {
    const h = engine(on, { spawn: 'silent' })
    await start($)
    await $.command.run({ command: 'tiktok', args: '' } as any)
    await until(() => h.toasts.length)
    expect(h.toasts[0]).toMatch(/Node 22 or newer on PATH/)
  })

  test("the helper's own reason (a busy port, an old Node) reaches the person once", async ($, on) => {
    const h = engine(on, { spawn: 'TikTok cannot start: port 48731 is used by another program' })
    await start($)
    await $.command.run({ command: 'tiktok', args: '' } as any)
    await until(() => h.toasts.length)
    await wait(20)
    expect(h.toasts).toEqual(['tiktok: TikTok cannot start: port 48731 is used by another program'])
  })

  test('/tiktok mute toggles the sound and says which way', async ($, on) => {
    const h = engine(on)
    await start($)
    const off: any = await $.command.run({ command: 'tiktok', args: 'mute' } as any)
    expect(off.text).toMatch(/not running/) // nothing started yet
    await $.command.run({ command: 'tiktok', args: '' } as any)
    const r: any = await $.command.run({ command: 'tiktok', args: 'mute' } as any)
    expect(r.text).toBe('TikTok: muted.')
    expect(h.sent).toContain('/mute')
    await $.command.run({ command: 'tiktok', args: 'stop' } as any)
  })
})
