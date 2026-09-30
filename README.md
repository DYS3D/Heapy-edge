# HEAPY Edge (site box)

Finds BAS devices on a client network, reads their points on a schedule, keeps the readings in a local buffer and sends them to HEAPY Trend Tracker over outbound HTTPS. Read-only to the BAS: it never writes to a device.

Plan: `docs/HEAPY Edge - Project Plan.html` (HEAPY Data Collection project).

## Layout

| Folder | What it is |
|---|---|
| `core/` | Node 22.13+ program, no npm packages: settings, driver host, scanner, poll scheduler, SQLite buffer, uploader, pairing/check-in, local setup page |
| `drivers/bacnet-ip/` | BACnet/IP driver (Python 3, BACpypes3, BSD licence). Also reaches MS/TP and other trunks through BACnet routers |
| `contracts/` | The fixed contracts: `driver-protocol.json` (core ↔ driver) and `upload-api.json` (box ↔ Trend Tracker) |
| `web/` | Setup page (HEAPY brand) served on port 8770 |
| `sim/` | Simulated BACnet site for testing: IP controllers, a router and a trunk of VAVs, with a slow device, one without ReadPropertyMultiple and some without COV |
| `tests/` | `selftest.js` (unit + site test), `soak.js` (long run), `mock-intake.js` (stand-in for the Trend Tracker intake API) |

## Run

```
pip install -r drivers/bacnet-ip/requirements.txt
node core/main.js --data ./data          # or HEAPY_EDGE_DATA=/data
```
Open `http://<box>:8770`, set the page password, set the BAS port address under Settings, then Connect to HEAPY with a pairing code.

Docker (Pi 5, mini-PC or Linux VM): `docker compose up -d`. GitHub Actions builds the image for arm64 and amd64 on every push to main and publishes it as `ghcr.io/dys3d/heapy-edge` (`.github/workflows/image.yml`); boxes pull it from there. Host networking is required so BACnet broadcasts reach the BAS network.

## Test

```
node tests/selftest.js          # needs Linux root for the simulated site network; --unit for unit checks only
node tests/soak.js --minutes 120 --interval 10
```

## Adding a protocol

Write a program that follows `contracts/driver-protocol.json` (JSON lines on stdin/stdout: hello, configure, discover, browse, read, optional subscribe), pick a key scheme (`modbus://`, `haystack://` …) and add it under `drivers` in the settings. The core handles schedules, rate limits, the buffer and uploads.

## Safety rules built in

- One request stream per device and one per routed trunk (e.g. an MS/TP network behind a router), a cap on parallel reads, and a per-device request rate (default 5/s).
- Reads batched with ReadPropertyMultiple sized to the device's APDU limit; falls back to ReadProperty for devices without it.
- Scans run inside set time windows; devices that stop answering are retried every 5 minutes, not hammered.
- Readings are only cleared after the server confirms a batch; resends reuse the batch id so nothing is stored twice.
- The box key is kept in `secret.json` (mode 600), never in settings or logs. The setup page needs a password and refuses cross-site posts.
