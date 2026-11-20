// Writes release notes for the current package version (Markdown for the GitHub release page).
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outIndex = process.argv.indexOf('--out');
const notes = `# Ron Assistant v${version}

## Downloads
- **Installer (recommended):** \`Ron-Assistant-Setup-${version}-x64.exe\`
- **Portable:** \`Ron-Assistant-Portable-${version}-x64.exe\` (no installation and no automatic updates; settings still live in %APPDATA%\\ron-assistant-claude)

## Highlights
- Ask Claude Code, Codex, and Hermes Agent at once using the sign-ins already on your PC, plus local LM Studio or Ollama models.
- 0.3.1: Gemini (Antigravity) has been removed.
- **Compare** shows each model's answer side by side; **Review together** has them review one another and writes one final answer that keeps real disagreements visible.
- Claude's answers (and local LM Studio / Ollama models) appear word by word as they are written.
- The installed app updates itself from GitHub Releases (can be turned off in Settings).
- Settings show each model program's version and location, warn when a program is newer or older than the version this app was checked with, and let you choose a location by hand.
- Choose how many earlier questions are sent with a new one; your description and preferences live in *My instructions*, which you can edit.
- Readable answers: Segoe UI at 18 px by default, adjustable size and width, light and dark themes, tables, code blocks, and safe links that open in your browser.
- Copy any answer or the whole discussion as plain text or Markdown.
- Speaks only the final answer (Windows voice or the JARVIS avatar), with mute, stop and replay.
- Saved instructions and optional conversation history, kept on this computer.

## Notes
- Windows shows a SmartScreen warning when a build is unsigned; signed builds are set up in docs/code-signing.md.
- Versions before 0.2.0 do not update themselves: install this one by hand once.
- Model answers use your existing plan quotas. No API keys are required or stored.
`;
if (outIndex > -1) fs.writeFileSync(process.argv[outIndex + 1], notes); else process.stdout.write(notes);
