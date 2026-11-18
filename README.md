# Ron Assistant

A personal Windows 11 app that sends one question to every model you turn on — Claude, Codex, Gemini, and any local model server — then either shows the answers side by side (**Compare**) or lets the models review one another and write one final answer (**Review together**). The final answer can be spoken by a Windows voice or the JARVIS avatar.

It is separate from Jarvis: its own program folder, its own data in `%APPDATA%\ron-assistant-claude`, no network ports, no background service. Your Jarvis installation is not changed.

## Install

Run `Ron-Assistant-Setup-0.1.0-x64.exe` (from `release\` or the GitHub release). Windows may show a SmartScreen warning because the build is not code-signed: choose **More info → Run anyway**. A portable `.exe` that needs no installation is also built.

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
- **Models & connections** — sign-in status, a **Test** button (sends one tiny question), which model writes the final answer, 1 or 2 review rounds, and per-model time limits.
- **Voice** — Windows voice, the JARVIS avatar (needs a live avatar conversation in Jarvis: *Command → Avatar*), or off.
- **History & privacy** — keep or don't keep conversations, delete all, and a table of exactly what is sent where.

### Links in answers

Every link is a **model suggestion that nobody has checked**. Links are marked ↗ and listed under *Links suggested by … — not checked*. **Check link** only confirms that the page responds; it does not confirm the content. The models are told not to claim they verified anything, and they run without web access.

## What is sent where

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
```

See [docs/feature-map.md](docs/feature-map.md) for the Jarvis inspection and reuse decisions.
