# HEAPY Edge: hand-off for a Claude Code session

Read `README.md` first, then this. The project plan (`docs/HEAPY Edge - Project Plan.html`)
has the phases, decisions and open items; the HEAPY Data Collection project in Claude has the
same plan plus `claude/heapy-edge-status.md`.

## Where things stand (2026-10-04, v0.3.3)

- **Every driver has passed its fault suite and its 24-hour soak.** The soak injects a fault
  every few minutes (devices off, lost/garbled replies, network loss, server errors and hangs,
  clock jumps, driver and box killed) and checks slot by slot: one reading per point per
  interval, every reading counted on the box and on the server. Verdicts (GitHub run ids):
  - BACnet/IP: PASS 2026-10-01 (36901590727) — 732,893 readings, 0 gaps, 0 lost
  - Modbus: PASS 2026-10-02 (36901607319) and again 2026-10-03 (37000696195) — 1,430,545 readings, 0 gaps, 0 lost
  - SNMP: PASS 2026-10-03 (36997864122) — 207,103 readings, 0 gaps, 0 lost
  - Haystack: PASS 2026-10-03 (36997869776) — 152,564 readings, 0 gaps, 0 lost
  - oBIX: PASS 2026-10-03 (36997875287) — 84,037 readings, 0 gaps, 0 lost
  - BACnet MS/TP: PASS 2026-10-04 (37118530932) — 343,680 readings, 0 gaps, 0 lost
  Box memory stayed flat (96–113 MB) in every soak; no unexpected box stops.
- Rule from Justin (2026-09-30): collection must be foolproof before anything connects to
  Trend Tracker. That bar is now met on the simulators; real equipment (bench kit) is still owed.
- 24-hour soaks: `tests/soak24.js --kind <driver>`; on GitHub, Actions → Soak test → Run
  workflow (five 330-minute parts, state handed between them; a part ends within 15 minutes
  of its budget even while faults are chained). Results go to the `soak-results` branch
  (`<driver>/state.json` with `pass`, `<driver>/soak.log`) and to artifacts. The repository
  is public, so Actions minutes are unlimited.
- Next: Phase 2 (central intake in Trend Tracker) — needs the central server decision.
  Then bench kit, LON/ARCNET decision, pilot site.

## Running the lab on a PC (WSL2 Ubuntu, as root)

The simulators use Linux network namespaces, a bridge, iptables and pseudo-terminals.
```
sudo -i
apt-get install -y iproute2 iptables faketime build-essential git python3-venv
python3 -m venv /opt/edge-venv && /opt/edge-venv/bin/pip install -r drivers/bacnet-ip/requirements.txt -r drivers/snmp/requirements.txt -r tests/requirements-test.txt
export PATH=/opt/edge-venv/bin:$PATH HEAPY_EDGE_PYTHON=/opt/edge-venv/bin/python
sh tools/build-bacnet-stack.sh            # MS/TP router and test devices → bin/
node --no-warnings tests/selftest.js      # 26 checks, ~10 min
node --no-warnings tests/faults.js        # BACnet/IP suite (faults-mstp.js, -modbus, -snmp, -haystack, -obix likewise)
```
`ip netns` works in the default WSL2 kernel (no systemd needed). If
`iptables` complains about nf_tables, `update-alternatives --set iptables /usr/sbin/iptables-legacy`.

## Things that bit us (don't repeat)

- `pkill -f <pattern>` in the same shell line as other text containing the pattern kills the
  shell itself. Run pkill alone.
- An orphaned lab box keeps polling: on an RS-485 bus it acts as a second master and
  corrupts the next test. `tests/lab.js` now kills its box on exit; still check `pgrep -af core/main.js`.
- A test clock shim (libfaketime, LD_PRELOAD) must not reach driver processes: it breaks
  `time.sleep` and made the MS/TP survey hear nothing. `core/driver-host.js` strips it.
- MS/TP: a controller that is off or quiet during the survey can later wake up on the
  box's address. The driver detects its I-Am on our MAC and rejoins elsewhere; the survey
  waits for a settled token ring and picks an address above the controllers.
- Modbus RTU: two masters on one bus is fatal; the driver listens first and refuses a bus
  where another master is polling.
- BACnet/IP: a fresh driver knows no routers (unknown-route to MS/TP devices behind them)
  until it asks Who-Is-Router-To-Network; it now does at start.
- The lab's gap check is slot-exact (one reading per interval slot per point). A late
  reading inside its own slot is fine; a missed slot never hides behind a neighbour.

## Commit conventions

Commit as `Justin Cross <jrcross@heapy.com>` and end messages with the Co-Authored-By and
Claude-Session lines the session provides. Push with the fine-grained token (Contents,
Workflows, Actions: read and write).

## Open items (need Justin)

1. Central server host/owner — blocks Phase 2, which is next.
2. LON and ARCNET: read through what the site has (JACE, iLON/SmartServer, BACnet router) vs
   direct hardware support built when a site needs it.
3. Bench kit parts list, then every driver against real equipment before the pilot.
4. Pilot site, and HEAPY IT review of the security sheet.
