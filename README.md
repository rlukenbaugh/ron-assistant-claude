# Ron Assistant

A personal Windows 11 app that sends one question to every model you turn on — Claude, Codex, Gemini, and any local model server — then either shows the answers side by side (**Compare**) or lets the models review one another and write one final answer (**Review together**). The final answer can be spoken by a Windows voice or the JARVIS avatar.

It is separate from Jarvis: its own program folder, its own data in `%APPDATA%\ron-assistant-claude`, no network ports, no background service. Your Jarvis installation is not changed.

## Install

Run `Ron-Assistant-Setup-0.2.0-x64.exe` (from `release\` or the GitHub release). Windows may show a SmartScreen warning because the build is not code-signed: choose **More info → Run anyway**. A portable `.exe` that needs no installation is also built.

The installed app **updates itself**: it checks GitHub Releases at start-up and every six hours, downloads a new version in the background, and installs it when you close the app (or at once with **Restart now** on the banner). The portable `.exe` does not update itself. Versions before 0.2.0 have no updater, so install 0.2.0 by hand once.

## Use

1. **Pick models** with the chips at the top. A green dot means signed in and ready; amber means it may need a sign-in; red means not installed or not running.
2. **Pick a mode**: *Compare* (each model answers on its own) or *Review together* (answers → each model reviews the others once → one model writes the final answer).
3. **Type or paste** your question and press **Ask** or **Ctrl+Enter**.
4. Read the **Final answer** panel. Each model's own answer is in the tabs below it (or **Show side by side**). Open **Review discussion** to see who said what.
5. **Copy ▾** on any panel copies as plain text or Markdown. **Copy complete discussion** copies everything. Ordinary selection with Ctrl+C works too.
6. **Stop** cancels a question. **Retry <model>** re-asks a model that failed. **Regenerate** asks the same question again.
7. Voice: 🔊 mutes/unmutes, ⏹ stops speaking, ↻ replays the last final answer. Only final answers are spoken automatically; use **Read aloud** on a model's answer to hear it.
8. **A− / A+** (or Ctrl − / Ctrl +) change text size; ◐ switches light/dark.

### Settings

- **My instructions** — preferences sent with every question (kept separately from history).
- **Models & connections** — sign-in status, the installed version and location of each program, a **Test** button (sends one tiny question), **Choose location…** if a program is installed somewhere the app does not look, which model writes the final answer, 1 or 2 review rounds, and per-model time limits. If a CLI is a newer minor/major version (or any older version) than the one this app was checked with, a warning says so, and it is repeated under any answer from that model that fails.
- **Voice** — Windows voice, the JARVIS avatar (needs a live avatar conversation in Jarvis: *Command → Avatar*), or off.
- **History & privacy** — keep or don't keep conversations, delete all, automatic update checks on/off with **Check for updates now**, and a table of exactly what is sent where.

### Links in answers

Every link is a **model suggestion that nobody has checked**. Links are marked ↗ and listed under *Links suggested by … — not checked*. **Check link** only confirms that the page responds; it does not confirm the content. The models are told not to claim they verified anything, and they run without web access.

## What is sent where

Update checks (installed app only, can be turned off) contact github.com for the release list and the installer; nothing about your questions, answers or settings is sent.


When a model is on it receives: your question, your saved instructions, up to three earlier questions and final answers from the same conversation, and — in Review together — the other models' answers and reviews. Claude goes to Anthropic, Codex to OpenAI, Gemini to Google (each through the sign-in already on this PC), local servers stay on this computer. No API keys are used or stored; answers count against your existing plans.

## Safety

- Models answer **text only**: Claude runs with tools, MCP servers and plugins disabled; Codex runs read-only with no shell, web search, sub-agents or user MCP config; Gemini runs in plan mode in a sandbox without auto-approval. Each runs in an empty working folder.
- Model processes get an environment with secrets removed and are marked as children, so they cannot start this app or the jarvis-agent-bridge again (no delegation loops).
- Review is bounded: one answer stage, at most two review rounds, one final stage, each call with a time limit.
- Answers are rendered as inert Markdown: embedded HTML and scripts appear as text, images are not loaded, only `http`, `https` and `mailto` links are clickable, and they open in your default browser. The window cannot navigate away.
- The Jarvis access key is read from Jarvis's own folder only at the moment of speaking and is never saved, logged, or given to a model.

## Develop

```powershell
npm install
npm start            # run the app
npm run lint
npm test             # unit tests
npm run test:e2e     # real Electron window with stand-in models
npm run test:live    # real Claude + Codex (uses a little quota); add "-- gemini" for Gemini
npm run dist:win     # installer + portable exe in release\
node tests/smoke/packaged-smoke.mjs   # packaged app + real Claude/Codex, throwaway data folder
```

## Verified on 2026-11-19 (0.2.0 additions)

- Lint clean; 17 unit tests (adds CLI discovery on PATH and chosen locations, version warnings, settings filtering); 10 Electron end-to-end tests (adds the update banner, Later, turning update checks off, and the page being unable to set a program location).
- Real connection check found all four CLIs at their usual locations with versions; it flagged Gemini (agy) 1.5.12 as newer than the tested 1.5.11 without a warning, as patch releases are allowed.
- An unpacked packaged build includes electron-updater, starts, runs the first update check after 15 s and logs a failure without disturbing the app. A full installer build and an end-to-end update from one GitHub release to the next have **not** been tried yet; that needs two published releases.

## Verified on 2026-11-18

- Lint clean; 14 unit tests; 8 Electron end-to-end tests (both models receive the question, independent answers in their own tabs, exactly one review per model and one final call, copy menus, Ctrl+C/Ctrl+V, links opening externally, hostile HTML rendered inert, Stop, rate-limited model + Retry, avatar failure falling back to the Windows voice, settings/instructions/history surviving a restart, history off).
- Live: 15/15 checks with the real Claude Code, Codex and Gemini sign-ins (Compare 14 s, Review together 57 s with three models, real process cancellation).
- Packaged app (`release\win-unpacked`) answered a real Review-together question with Claude and Codex: 7/7 checks.
- The original Jarvis kept running throughout (all four agents detected, avatar ready); none of its files or the jarvis-agent-bridge were changed.

## Finding the model programs

Each CLI is looked for in this order: the location you chose in Settings, its usual install folder (`%USERPROFILE%\.local\bin\claude.exe`, `%APPDATA%\npm\node_modules\@openai\codex\bin\codex.js`, `%LOCALAPPDATA%\agy\bin\agy.exe`, `%LOCALAPPDATA%\hermes\bin\hermes.exe`), then every folder on `PATH` (for Codex, the `codex.cmd` shim is followed to its script). A chosen location can only be set through the file picker; the page cannot set one. The versions the command lines were checked with are the `testedVersion` values in `src/core/adapters.js`; update them after re-running `npm run test:live` on a new CLI version.

## Logs and crashes

`%APPDATA%\ron-assistant-claude\logs\app.log` holds status lines only (never questions, answers or keys). It is moved to `app.log.1` when it passes 1 MB. Uncaught errors, unhandled promise rejections, page errors and crashed processes are recorded there; if the window's page crashes it is reloaded (at most three times a minute).

## Known limitations

- **JARVIS avatar speech was not played live in testing.** The route is the one the bridge verified earlier, and failure handling was tested, but speaking through the avatar needs a live avatar conversation (Command → Avatar) and uses Jarvis Cloud avatar minutes. Jarvis accepting text does not prove sound played, and **Stop speaking** cannot interrupt the avatar once it has the text.
- **Hermes** is installed but not signed in (`hermes model`), so its adapter is untested and off by default. Its `--safe-mode` disables plugins and MCP, but Hermes has no verified "no tools" switch.
- **Gemini (Antigravity)** has no switch that removes all tools; it runs in plan mode, sandboxed, without auto-approval, in an empty folder. It is off by default.
- **Ollama** is not installed and **LM Studio**'s server is not running, so local models show as unavailable; the adapter (OpenAI-compatible HTTP) was unit-checked, not run against a real server.
- Links are never verified by the models. **Check link** confirms only that a page responds.
- Answers are not streamed word by word; each model's answer appears when it is complete.
- The installer is **not code-signed**, so SmartScreen will warn (also for each update, since electron-updater cannot check a publisher signature on an unsigned build). Installing was not run on this PC, to avoid adding shortcuts that might clash with the other "ron-assistant" build in progress.
- Context sent to models is limited to the last three questions and answers of a conversation.

See [docs/feature-map.md](docs/feature-map.md) for the Jarvis inspection and reuse decisions.
