# Implemented protocol subset

This document describes the subset used by this converter. It combines related
[Salus/Computime protocol research](https://github.com/mikkelke/salus-zigbee/blob/main/PROTOCOL.md),
static analysis of official gateway artifacts, and attended CFTP 2010 / CFKL8
observations. No vendor executable, firmware image, disassembly listing or
household packet capture is distributed with this project.

## Endpoints and framing

| Role | Endpoint |
|---|---|
| CFTP thermostat | 9 |
| CFKL8 controller | 8 |
| Coordinator source | 1 |

Manufacturer traffic uses cluster `0xFC00`, manufacturer code `0x1078` and
profile `0x0104`. Thermostat frames use server-to-client ZCL direction; CFKL8
frames can use client-to-server direction. Both command tables are registered
to allow the SDK to decode these manufacturer-specific frames.

Outgoing responses use server-to-client direction, the manufacturer flag and
disabled default responses. The converter registers device-local Basic
attribute defaults identifying the coordinator as `Computime / SAU2AG1`, as
expected by the related gateway protocol. It does not rewrite the coordinator
firmware or its ZDO manufacturer descriptor. Those differences and adapter
compatibility remain part of the tested-version boundary.

## Commands used

| Command | Handling |
|---|---|
| `0x10` | Answer a valid seven-byte sync request |
| `0x81` | Send a 15-byte sync response with assigned device number and clock |
| `0x37` | Verify the observed controller-number ACK after a fresh successful offer |
| `0x16` | Resolve a requested controller number within that thermostat's configuration |
| `0x86` | Return success plus current controller short address, or not-found |
| `0x31` | Decode supported legacy thermostat temperature fields |
| `0x32` | Send a bounded heating-target command or read-only zone-table request |
| `0x33` | Record a command echo or decode a complete B70 zone-table report |

Thermostat/CFKL8 zone pairing uses their native `0x18`, `0x88`, `0x14` and
`0x84` exchange. The converter does not synthesize those messages or heating
demand reports.

## Controller number and lookup

A thermostat receives device number `0x20`; each CFKL8 receives its configured
controller number. Observed CFKL8 sync ACK payloads are `11 00 00` for number 1
and `12 00 00` for number 2. Support for further ACK values is not inferred.

An ACK verifies acceptance only when it belongs to the exact current controller
and a matching successful offer within the bounded commissioning window.
Lifecycle epochs prevent an old in-flight offer from validating a replacement
or stopped controller. Verified acceptance is persisted in device metadata.
Seeing a device, sending an offer, and observing an accepted controller number
are distinct states.

The one-byte `0x16` request selects a controller number. A successful `0x86`
response contains `01` followed by the current controller short address in
little-endian order; not-found is `00 ff ff`. Discovery never falls back to a
controller assigned to another configured installation.

## Clock response

The 15-byte sync payload contains:

| Bytes | Meaning |
|---|---|
| 0 | Assigned device number |
| 1 | Normal-response status `00` |
| 2–5 | Local wall-clock seconds since 2000-01-01, little-endian |
| 6 | Current DST flag and 24-hour-display flag |
| 7 | Native standard-timezone table index |
| 8 | Configured DST increment in hours |
| 9–12 | Auxiliary-receiver addresses, `ff ff ff ff` in this implementation |
| 13 | Protocol online flag, ASCII `1` |
| 14 | Zero |

The online flag belongs to the device protocol; it does not establish a cloud
connection. The configured IANA timezone supplies the wall clock, while the
explicit standard and DST offsets supply the protocol fields. The encoder
requires an exact native-table entry and supports DST increments of zero or
one hour. Other DST patterns need additional evidence and implementation.

## Legacy temperature prefix

Only a complete 77-byte legacy record is accepted. Its masked tag must be in
`1..0x5f`, and the low nibble of byte 1 must be one of `1`, `3`, `D` or `E`.
These observed forms share the native temperature prefix:

- Byte 2: room temperature, `(value - 0x20) / 2` °C.
- Byte 3: reported heating target, using the same conversion.

Raw room-temperature bytes `0x7b` and `0x7d` are sentinel values and yield a
null temperature. The rest of the record is left uninterpreted. In particular,
a schedule-shaped body does not establish schedule support, and these records
must not be confused with newer thermostat generations.

Static analysis maps subtype 1 and subtype D to different programming-mode
values. During commissioning, an unusual display state and an echoed but
unapplied target were observed before normal control worked. That correlation
does not establish a firmware cause, a fixed timeout or a mode-write command.

## Heating-target command

The `B34` write is five bytes: one handle, ASCII `B34`, then
`target_celsius × 2 + 0x20`. Targets are limited to 5–35°C in half-degree steps.
The converter requires its exact real controller to be ready before sending.

An identical `0x33` echo is reception evidence only. A subsequent supported
`0x31` status containing the target establishes the reported result. The
converter does not optimistically publish the requested value as applied.

## CFKL8 B70 table

The request contains one handle followed by ASCII `B70` and its native request
arguments. The supported response is exactly 59 bytes: handle, `B70`, five zero
bytes, count `08`, then twelve three-byte slots beginning at offset 10. Each
slot contains a big-endian short address and a raw flag. `ffff` means free.
The first eight slots correspond to the exposed physical zones. Offsets 46 and
47 hold diagnostic LQI and signed RSSI.

Only the observed native trailer and the observed all-zero trailer ending in
`78` are accepted. Truncated data, unknown count/layout and unknown trailers
cannot establish zone ownership. A slot matching a configured thermostat's
current short address establishes table ownership, not actuator position,
water flow or a relay state.

### Observed zone-activity bit

An attended trial with the installed protocol implementation on one CFKL8
showed this sequence for one assigned zone:

| Observed zone LED | Fresh B70 flag |
|---|---|
| Off before the target increase | `0xf4` (244) |
| On after the thermostat confirmed the increased target | `0xfc` (252) |
| Off after the thermostat confirmed its restored target | `0xf4` (244) |

The other assigned zones stayed at `0xf4`. Thus bit `0x08` tracked the zone LED
in this OFF–ON–OFF trial and is a candidate zone-active/heating-demand bit. This
does not establish physical relay feedback, actuator position, pump operation
or water flow, nor behavior on other firmware. Other flag bits remain
uninterpreted.

The converter preserves raw flags and exposes `zone_1_heating` through
`zone_8_heating` as read-only, refreshable binary indications. It interprets
bit `0x08` only for occupied slots with the observed flag forms `04`, `0c`,
`f4` or `fc`; empty slots and other flag values yield unknown. Interpreting
the low-bit forms `04`/`0c` equivalently is an inference from the observed
table variants, not a separate LED trial. Invalid B70 tables and a new sync
request for an unassigned/different controller number clear these indications.

Refreshing any heating entry sends the same B70 query as `zone_table`; all
entries share the five-second query throttle. There is no heating-state write
or automatic polling. The trial used explicit B70 queries; automatic reports
on every heating transition have not been established. A stored indication
can be stale, so check `zone_table_seen` and request a fresh table before
interpreting it as current activity.

## Confidence and remaining work

Hardware checks cover temperature reports, applied target changes, two
controllers with independent numbers, native zone pairing and attended zone
LED responses. The public refactor is tested with synthetic fixtures and the
pinned SDK, without a radio adapter. Broader firmware/adapter compatibility,
other controller numbers, full coordinator outages, schedules and operating
modes remain unverified or unimplemented.
