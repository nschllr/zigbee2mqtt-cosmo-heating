# COSMO CFTP / CFKL8 for Zigbee2MQTT

Experimental Zigbee2MQTT external converter for **COSMO CFTP 2010 room
thermostats and CFKL8 wiring centres**, using an existing Zigbee coordinator
instead of a COSMO gateway or CCO.

The protocol implementation was exercised on two CFKL8 controllers and six
CFTP 2010 thermostats. Temperature reporting, target changes and the intended
physical zone LEDs were checked in both directions. This public configuration
and packaging refactor has offline tests; it has not yet been installed on a
live heating system. Other hardware and firmware variants need verification.

## What it provides

- Room temperature and reported heating target.
- Heating-target control from 5–35°C in 0.5°C steps, confirmed by device reports.
- A real-controller lookup for each explicitly configured thermostat.
- Independent state for controller numbers **1 and 2** on the same network.
- Read-only CFKL8 zone-table queries and commissioning diagnostics.
- Refreshable per-zone heating indications from the latest controller snapshot.

The real thermostat and CFKL8 own their native zone pairing and heating
exchange. The converter does not generate thermostat heat-demand messages.
It implements no firmware updates, remote factory resets, remote zone pairing,
schedule management, operating-mode changes, battery reporting or measured
actuator/pump state. The `zone_1_heating` through `zone_8_heating` indicators
interpret the flag bit that tracked a zone's LED in an attended off/on/off
trial; see the [zone-activity evidence](docs/protocol.md#observed-zone-activity-bit).
Raw flags remain available as diagnostics. Empty slots and unsupported flags
report unknown. These indications do not measure physical relay feedback or flow.

Use the refresh action on any **Zone N heating** entry, or refresh `zone_table`,
to read all zones. **Zone snapshot time** (`zone_table_seen`) shows when the
controller last supplied a valid table. The converter does not poll these
values; automatic reports on every heating transition are unverified. Allow
at least five seconds between refreshes.

Home Assistant receives temperature sensors and a numeric target control through
Zigbee2MQTT's MQTT discovery. This release does not create a full `climate`
entity or a household dashboard.

## Requirements and tested versions

Use Node.js 24 to build and test the converter. The protocol was exercised with:

| Component | Tested version |
|---|---|
| Zigbee2MQTT | 2.14.2 |
| zigbee-herdsman | 10.10.0 |
| zigbee-herdsman-converters | 26.115.1 |
| Coordinator | SONOFF Zigbee Dongle Plus, Z-Stack firmware 20250321 |

The converter relies on herdsman's device registry, custom-cluster, persistence
and lifecycle APIs. Passing tests against the pinned dependencies does not
establish compatibility with every Zigbee2MQTT version or adapter.

## Configure and build

```sh
npm ci
cp config.example.json config.local.json
```

Edit `config.local.json` before building. Supply the printed IEEE address of
each CFKL8 and its thermostats, the controller number, and the clock settings.
The example uses synthetic addresses which must be replaced with your own.

Each controller entry has:

- `controllerIeee`: that controller's full `0x`-prefixed IEEE address.
- `thermostatIeees`: an explicit allowlist of thermostats belonging to it.
- `wcNumber`: `1` or `2`, unique across the configuration.

Every address must be unique across all entries. The converter intentionally
does not match every device with the manufacturer name `Computime`. A
thermostat not listed in the configuration is left alone.

Clock settings are explicit rather than inherited from a Docker container:

| Setting | Meaning |
|---|---|
| `timeZone` | IANA timezone, for example `Europe/Berlin` |
| `standardUtcOffsetMinutes` | Standard-time offset from UTC, excluding summer time |
| `daylightSavingOffsetMinutes` | Summer-time increment: `0` or `60` |

The standard offset must exist in the native protocol's timezone table. The
configured IANA timezone must agree with those offsets. Unsupported offsets
and daylight-saving patterns are rejected instead of rounded to a nearby
timezone. Central European clock behavior was exercised on hardware; the
other clock configurations have software coverage only.

```sh
npm test
npm run build
```

The generated **`dist/cosmo.mjs`** contains the converter and your configuration
in one file. Optional paths:

```sh
npm run build -- --config path/to/config.json --output path/to/cosmo.mjs
```

## Install in Zigbee2MQTT

1. Back up your Zigbee2MQTT configuration and coordinator network.
2. Enable external JavaScript with Zigbee2MQTT's `enable_external_js` setting.
   New installations of Zigbee2MQTT 2.11 and later disable it by default.
3. Put the generated `cosmo.mjs` in the `external_converters` directory beside
   Zigbee2MQTT's `configuration.yaml`, or add its contents through **Settings →
   Dev console → External converters**.
4. Confirm the converter is loaded before commissioning any heating devices.
   Keep only one converter responsible for the same device addresses.

See the official [external-converter documentation](https://www.zigbee2mqtt.io/advanced/more/external_converters.html)
for the installation mechanism and external-JavaScript setting. The generated
file exports Zigbee2MQTT device definitions and imports the SDK supplied by
Zigbee2MQTT; no project directory or local configuration file is needed on the
Zigbee2MQTT host.

Follow [commissioning.md](docs/commissioning.md) to migrate a controller and
assign its thermostats to the recorded physical zones. Controller reset clears
existing assignments, so record the whole controller's room-to-zone mapping
and desired temperatures first.

## Verify operation

After joining, the controller should report
`physical_controller_state: ready`. Refresh its `zone_table` expose and compare
each zone's short address with the intended thermostat's current network
address. Short addresses can change after rejoining; IEEE addresses identify
the configured devices.

For each room, record its current target, request a suitable test target, and
wait for a **fresh thermostat status** containing that target. A command echo
only proves that the frame arrived. Check the intended controller zone LED,
then restore the recorded target and check the response again. Pump operation
may be delayed by the controller and must be observed separately.

Following reset, a thermostat may temporarily show additional profile/display
elements and echo commands while continuing to report its previous target.
Let it settle and verify the fresh reported target before treating a command
as successful. No fixed settling duration or automatic recovery command has
been established.

## Limits and troubleshooting

- Only controller numbers 1 and 2 have observed commissioning ACKs. Other
  numbers are rejected by this release.
- Only the observed legacy 77-byte status formats and two complete 59-byte
  CFKL8 zone-table layouts are decoded. A rejected frame needs investigation;
  another Salus/Computime product is not automatically compatible.
- Controller-number acceptance, zone ownership and physical heating operation
  are separate checks. The diagnostic fields describe the first two.
- The controller is a Zigbee router; thermostats can have other routers as
  their parents. A room's physical zone assignment does not identify its
  radio route.
- Full operation with both the HA host and coordinator unpowered remains
  unverified. Router placement, sleepy-device parenting and firmware behavior
  affect recovery. Test the actual installation before relying on an outage
  assumption.

For a compatibility report, include model/firmware information, SDK versions,
the last decoded command and an anonymized minimal frame example. Review logs
before posting: device addresses, targets, timestamps and topology can reveal
details of an installation.

## Development and publication

```sh
npm test
```

Tests use synthetic IEEE addresses and fake endpoints. They serialize frames
through the real SDK without constructing a radio adapter or contacting a
Zigbee network. [Protocol notes](docs/protocol.md) describe the implemented
fields and confidence boundaries.

Keep `config.local.json`, other real configurations, generated `dist/` output,
network backups, packet captures and household logs private. The build embeds
the supplied addresses in its output. This source directory contains no
deployment credentials, household inventory or extracted vendor firmware.

The software is MIT licensed. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for
attribution, including the related [salus-zigbee project](https://github.com/mikkelke/salus-zigbee).
