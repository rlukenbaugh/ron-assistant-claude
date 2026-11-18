# Jarvis 1.1.60 feature map and reuse decisions

Inspected on 2026-11-18. Installation: `E:\Program Files\jarvis-live\jarvis-1.1.60-windows-x64\Jarvis`.
Method: REA-MCP (`inspect_desktop_application`, `inspect_electron_fuses`, `analyze_javascript_application` on 14 selected sources),
reading the unpacked sources, read-only calls to the running server, and CLI checks. No Jarvis file was changed.

**Verified** = seen in shipped code *and* observed on this PC. **Static** = seen in code only. **Assumed** = inferred.

## What Jarvis is

| Area | Finding | Status |
|---|---|---|
| Packaging | Electron app, unpacked `resources/app` (no ASAR). Fuses: RunAsNode on, ASAR integrity off, OnlyLoadAppFromAsar off. A `jarvis-server.cmd` runs the backend with `ELECTRON_RUN_AS_NODE`. | Verified (REA fuse reader, directory scan) |
| Server | Express backend `backend/server.js` (3,849 lines) on port 4000. Routes need `x-api-key` (key in `%LOCALAPPDATA%\JarvisServer\data\.env`). | Verified (unauthenticated health call → 401; keyed `/api/agents` and `/api/avatar/availability` → 200) |
| Agent detection | `backend/agents/detect.js` runs `<cli> --version` for agy (Gemini), claude, hermes, codex, openclaw, gemini. Codex model list needs an OpenAI API key; it lists none with a ChatGPT sign-in. | Verified: running server reports gemini 1.5.11, claude 2.1.322, hermes 0.22.7, codex 0.170.0 |
| Agent execution | One agent at a time. `ClaudeWorker` runs `claude -p --output-format text --model X` with the prompt on stdin and **no tool restrictions**. `AgyWorker` runs `agy --dangerously-skip-permissions`. `HermesCLIWorker` passes the prompt as a `-q` argument. Output streams to the UI and the first 500 characters are sent to TTS. | Static |
| Response handling | Results broadcast over WebSocket as `agent_result`; plain text, no Markdown sanitising layer in the backend; failures become generic alerts. | Static |
| Speech | `TTSEngine` (local XTTS server on 8000/8010), Windows `System.Speech` fallback via PowerShell (`tts/systemVoice.js`), Gemini Live / OpenAI Realtime voice providers. | Static |
| Avatar | Live avatar via Jarvis Cloud streamer. `/api/avatar/text` sends text into the avatar conversation; `/api/avatar/speak` uses ordinary TTS. | Verified: availability reports "Live avatar ready, source cloud". `/api/avatar/text` delivery was verified earlier by the jarvis-agent-bridge work |
| Settings | `/api/settings` (owner key) for LLM/TTS/avatar servers, RSS, wallet; persisted under the server data folder; desktop profile in `%APPDATA%\Jarvis`. | Static |
| Memory | `ConversationMemory` appends the last 100 turns to `memory.json`. There is no separate "saved instructions" store. | Static |

Known defect (from the bridge work, still relevant): 1.1.60's Claude callback referenced an undeclared `voiceSocket`; the bridge applied a one-line backed-up repair.

## Other connections on this PC

| Provider | Finding | Used by Ron Assistant |
|---|---|---|
| Claude Code 2.1.322 | `claude auth status` → logged in with a claude.ai account | Yes, tools/MCP/plugins off |
| Codex CLI 0.170.0 | `codex login status` → Logged in using ChatGPT | Yes, read-only, no shell/web/MCP |
| Antigravity `agy` 1.5.11 (Gemini) | Lists Gemini models; a test question answered in plan + sandbox mode without auto-approval | Yes (off by default) |
| Hermes 0.22.7 | Installed, but `No access token found for Nous Portal login` | Shown as needing sign-in |
| Ollama | Not installed | Shown as unavailable |
| LM Studio | Folder present, server not running on 1234 | Shown as unavailable until started |

## Reused, adapted, or not reused

| Component | Decision |
|---|---|
| `C:\dev\jarvis-agent-bridge` | **Adapted.** Its tested Claude/Codex restricted command lines, output parsers, secret-filtering child environment, and `/api/avatar/text` speech call were carried into `src/core` and extended (Gemini, Hermes, local servers, failure classification, cancellation). The bridge's fixed 4-step Claude→Codex chain was replaced by a parallel, N-model, bounded review. The bridge itself is untouched and still works. |
| Jarvis agent workers | **Not reused.** They grant tools/skip permissions and handle one agent at a time. |
| Jarvis agent detection | **Pattern reused** (version probes), extended with quota-free sign-in checks. |
| Jarvis live avatar | **Reused through its API**, only when a Jarvis avatar conversation is live. Key read at call time, never stored or sent to a model. |
| Jarvis TTS / System.Speech | **Not reused**; Ron Assistant uses Windows voices through the browser speech engine, so speech works without Jarvis running. |
| Jarvis memory | **Not reused**; Ron Assistant keeps instructions and history in separate files in its own folder. |
