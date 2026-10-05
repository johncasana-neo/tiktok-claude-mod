# TikTok for Claude Code

A [Claude Code](https://claude.com/claude-code) mod that plays TikTok in a small Chrome window next to your terminal **while Claude works**, and pauses it the moment Claude is done.

> **Unofficial.** Not affiliated with, endorsed by or connected to TikTok or ByteDance. See [Disclaimer](#disclaimer).

- **Windows only** for now. It needs **Node 22+** (on `PATH`) and **Chrome or Edge**.
- Tested with **Claude Code 2.1.289**. Mods are a recent Claude Code feature: an older version may not load it at all.
- Nothing starts until you type `/tiktok`.

## What it does

1. You type `/tiktok`. A narrow Chrome window opens on the right edge of your screen, full height, like a side panel.
2. You send Claude a prompt. If the turn lasts more than ~4 seconds, the video starts playing (short answers never flash it on and off).
3. Claude finishes. The video **pauses** where it was, the status line shows `⏸ TikTok`, and a toast in the terminal says `Claude is done: TikTok paused`.
4. Next prompt, it resumes.

The window is regular TikTok, so you can scroll in it as on tiktok.com, or use the commands below.

## Install

From this repository as a marketplace:

```sh
claude plugin marketplace add johncasana-neo/tiktok-claude-mod
claude plugin install tiktok@tiktok-claude-mod
```

Or load it straight from a clone, for one session:

```sh
git clone https://github.com/johncasana-neo/tiktok-claude-mod.git
claude --plugin-dir tiktok-claude-mod/plugins/tiktok
```

Or in every project, by naming the folder in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\plugins\\tiktok" } }
```

Run `claude plugin validate plugins/tiktok` to check a copy before using it.

## Commands

| Command | What it does |
| --- | --- |
| `/tiktok` | Open TikTok (or join the window another session opened). It plays while Claude works. |
| `/tiktok next` / `prev` | Change video. Closes TikTok's login pop-up first when it is in the way. |
| `/tiktok mute` | Turn the sound off or on. New videos inherit it. |
| `/tiktok status` | Playing or paused, sound, how many Claude sessions use the window, and whether this one drives it. |
| `/tiktok restart` | Close the window and open a fresh one. |
| `/tiktok login` | Open a plain Chrome window on TikTok's login page, with nothing scripted, to sign in. |
| `/tiktok stop` | Close the window, for every session using it. |
| `/tiktok help` | List these options. A mistyped option shows the list and opens nothing. |

## Signing in

Without an account you get generic videos, and TikTok shows a login pop-up after a few of them. Signing in gives you your own feed.

- Run **`/tiktok login`**, sign in (the QR code is the method that got furthest in testing), close the window, then run `/tiktok`.
- The window is a normal Chrome profile at `~/.claude-mods/tiktok/profile`, so cookies are stored there like in any Chrome profile.
- TikTok may refuse sign-in methods in a browser it thinks is automated (Google, Facebook and Apple in particular), or ask to verify your identity. If it says *"Maximum number of attempts reached"*, that is TikTok's own limit: stop retrying and wait a few hours.

## Several Claude Code sessions at once

All sessions share one window. It plays while **any** session that ran `/tiktok` is working, and pauses when all are done. A session that vanishes without saying goodbye is forgotten after 90 seconds. The window closes when the last session leaves, or after a minute with nobody using it. A session that never ran `/tiktok` does not touch the window. `/tiktok stop` and `/tiktok login` close it for everyone.

## How it works

- `hooks/register.ts` listens to Claude Code's turn events and the `/tiktok` command.
- `helper/tiktok.cjs` is a small Node program with no dependencies. It starts Chrome in app mode and drives the page over the Chrome DevTools Protocol (pause/play, scroll, mute, window position). It listens on `127.0.0.1:48731` for the mod's commands.
- While paused, a small script in the page re-pauses anything TikTok tries to autoplay, unless you just clicked.

## Privacy and security

- The mod sends nothing anywhere itself. TikTok sees an ordinary Chrome window.
- Your TikTok session lives in the Chrome profile folder above. Treat it like a password: never commit or share it.
- The helper's control server only accepts requests that carry a custom header and a `localhost` `Host`. A web page in your browser can do neither, so it cannot pause or close your window.
- While the window is open, Chrome's debugging port is open on `localhost` (random port). Any program running as you could use it. The `/tiktok login` window is opened without it.

## Limitations

- Windows only: it looks for Chrome or Edge in the usual Windows folders (`CHROME_PATH` overrides). macOS and Linux paths are not written or tested.
- The control port `48731` is fixed. If another program uses it, the mod says so and opens nothing.
- TikTok's page changes without notice. The login pop-up and the "pick your interests" modal are handled today; a new blocker may stop `next` until it is.
- Signing in and staying signed in depends on TikTok. This mod does not bypass any of its checks.

## Troubleshooting

| Symptom | Try |
| --- | --- |
| Toast: *needs Node 22 or newer* | Install Node 22+ and check `node -v` works in a new terminal, then restart Claude Code. |
| Toast: *needs Chrome or Edge* | Install one, or set `CHROME_PATH` to its `.exe` if it lives in an unusual folder. |
| Toast: *port 48731 is used by another program* | Close that program, then `/tiktok`. |
| `/tiktok next` says it is not running | `/tiktok status`, then `/tiktok restart`. |
| Video does not start on a short prompt | Intended: it waits ~4 s. |
| Updated the mod but nothing changed | The helper keeps running: `/tiktok restart`. |
| Sound should be off | `/tiktok mute`. |

## Development

```sh
claude plugin validate plugins/tiktok   # manifest and hooks
claude plugin test plugins/tiktok       # unit tests, no Chrome needed
```

`plugins/tiktok/tsconfig.json` extends a file Claude Code writes next to the mod the first time it loads it (`.claude-plugin/types/`, git-ignored). In a fresh clone your editor flags it until then; nothing else depends on it.

The tests replace Chrome and the helper with stand-ins. The helper itself has no automated tests; it was checked by hand against a real Chrome. For manual runs it reads two environment variables: `TIKTOK_PORT` (control port) and `TIKTOK_LEASE_MS` (how long a silent session is remembered).

```
.claude-plugin/marketplace.json     marketplace
plugins/tiktok/
  .claude-plugin/plugin.json        manifest
  hooks/register.ts                 the mod: commands and turn events
  helper/tiktok.cjs                 Chrome + DevTools + control server
  tests/tiktok.test.ts
```

## Disclaimer

This project is an independent, unofficial tool. "TikTok" is a trademark of its owner. Automating a website's interface can go against its terms of service and may put your account at risk; you use this mod at your own risk. The mod only plays, pauses, mutes and scrolls; it does not like, follow, comment or collect data.

## License

[MIT](LICENSE)
