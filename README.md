# Guess the Imposter — Nearby play (WiFi + Bluetooth)

Everyone plays on their **own device**. One machine (laptop / PC / Raspberry Pi) runs `server.js`;
it deals the cards and counts the votes, and sends each player only their own card.

Files: `imposter.html` (the game) · `server.js` (the server, no dependencies for WiFi) · `package.json` (only for Bluetooth)

## WiFi (works out of the box)

1. Install Node.js 18 or newer.
2. In this folder run: `node server.js`
3. Everyone joins the **same WiFi** and opens the address printed as `Share on WiFi` (e.g. `http://192.168.1.20:3000`).
4. Tap **Nearby Play → Connect over WiFi**. One person taps *Create room*; others scan the QR code or type the 4-letter code.

No router? Turn on a phone hotspot (or the laptop's hotspot), connect everyone to it, and run the server on the laptop.

## Bluetooth

Browsers can only be Bluetooth *clients*, never discoverable. So the machine running `server.js` also acts as the
Bluetooth **host**, and phones connect to it (device name **Imposter**). Bluetooth and WiFi players can share a room.

1. On the host machine: `npm install` (installs the optional `@abandonware/bleno`), then `node server.js`.
   You should see `Bluetooth host advertising as "Imposter"`.
   - **macOS**: works; allow Bluetooth for your Terminal when asked.
   - **Linux / Raspberry Pi**: usually needs BlueZ's own service stopped and root (`sudo node server.js`).
   - **Windows**: bleno is hard to set up there; use macOS/Linux, or just WiFi.
2. On each phone, use **Chrome on Android** (or desktop Chrome): **Nearby Play → Bluetooth → Scan for host**.
   iPhone browsers have no Web Bluetooth, so iPhones must use WiFi.
3. Web Bluetooth requires a **secure page**. If the phone opened the game from `http://192.168...`, the Bluetooth
   button will say so. Either run `node server.js --https` and open the *Secure page* address (accept the warning), or
   in Android Chrome open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add the server's http address, relaunch.

Notes: Bluetooth is slower than WiFi (a screen update can take about half a second). Some Bluetooth stacks
serve only one connected phone at a time (I believe Linux/bleno does; macOS can do more) — for bigger groups without
a router, use a hotspot with WiFi instead.

## Options

`node server.js --port 3000 --https --https-port 3443 --no-ble`

Word packs are read from `imposter.html` at startup, so edit them there.

## Troubleshooting

- *Can't connect over WiFi*: same network? Some guest/public WiFi blocks device-to-device traffic — use a hotspot.
  Allow Node through the firewall when the OS asks.
- *Round in progress, can't join*: rejoin using the exact name you had; you take your old seat back.
- *Host dropped*: after 30 s another player automatically becomes host.
- "Generate a pack with AI" (Word Packs) only works when the page is opened inside Claude.
