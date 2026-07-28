# XPUOJ plugin

XPUOJ connects Codex to the Agent Relay built into the official XPUOJ website. It runs locally and
does not require a browser extension.

## Install

```bash
codex plugin marketplace add ohtensorplay/xpuoj
codex plugin add xpuoj --marketplace tensorplay-xpuoj
```

The plugin starts `xpuoj mcp` locally. On first use:

1. Open the requested page with the `xpuoj_open_page` tool.
2. In XPUOJ, press <kbd>Ctrl</kbd>+<kbd>B</kbd>.
3. Keep the relay URL at `http://127.0.0.1:7423`, leave the pairing token empty, and click
   **Connect**.

Your XPUOJ login remains in the browser. The same flow works in Chrome, Edge, Firefox, Safari, and
other modern browsers. In Chrome or Edge, allow XPUOJ's **Local network access** permission when
prompted.

Submission remains controlled by XPUOJ's Agent Relay setting. Its default mode asks for
confirmation in the browser before creating a submission.

## npm package

```bash
npm install --global @tensorplay/xpuoj
xpuoj mcp
```
