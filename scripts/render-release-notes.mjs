// Writes release notes for the current package version (Flight Tracker Pro format).
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outIndex = process.argv.indexOf('--out');
const notes = `# Ron Assistant v${version}

## Downloads
- **Installer (recommended):** \`Ron-Assistant-Setup-${version}-x64.exe\`
- **Portable:** \`Ron-Assistant-Portable-${version}-x64.exe\` (no installation; settings still live in %APPDATA%\ron-assistant-claude)

## Highlights
- Ask Claude Code, Codex, and Gemini (Antigravity) at once using the sign-ins already on your PC.
- **Compare** shows each model's answer side by side; **Review together** has them review one another and writes one final answer that keeps real disagreements visible.
- Readable answers: Segoe UI at 18 px by default, adjustable size and width, light and dark themes, tables, code blocks, and safe links that open in your browser.
- Copy any answer or the whole discussion as plain text or Markdown.
- Speaks only the final answer (Windows voice or the JARVIS avatar), with mute, stop and replay.
- Saved instructions and optional conversation history, kept on this computer.

## Notes
- Windows may show a SmartScreen warning if this build is unsigned.
- Model answers use your existing plan quotas. No API keys are required or stored.
`;
if (outIndex > -1) fs.writeFileSync(process.argv[outIndex + 1], notes); else process.stdout.write(notes);
