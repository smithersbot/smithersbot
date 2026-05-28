# SmithersBot Chrome Extension (Browser Relay)

Purpose: attach SmithersBot to an existing Chrome tab so the gateway can automate it through the local CDP relay server.

## Dev / Load Unpacked

1. Build and run the SmithersBot gateway with browser control enabled.
2. Ensure the relay server is reachable at `http://127.0.0.1:18792/` by default.
3. Install the extension to a stable path:

   ```bash
   smithersbot browser extension install
   smithersbot browser extension path
   ```

4. Chrome -> `chrome://extensions` -> enable "Developer mode".
5. "Load unpacked" -> select the path printed above.
6. Pin the extension. Click the icon on a tab to attach or detach.

## Options

- `Relay port`: defaults to `18792`.
