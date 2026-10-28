# Commissioning CFTP 2010 and CFKL8

Use the manual matching the exact device revision. The procedure below records
the sequence exercised with CFTP 2010 and CFKL8 devices; display labels and
reset behavior can vary between products.

## Record the existing installation

Before resetting anything, record every thermostat's IEEE address, intended
controller and physical zone, group, desired temperature and custom schedule.
Record controller settings and any heat-source connection. A controller reset
clears its existing pairings, and a thermostat reset clears its local settings.
Preserve the original CCO and its configuration for recovery.

Build and load the converter with the complete explicit device allowlist.
Assign each controller a unique `wcNumber` of 1 or 2. The JSON association tells
the converter which real controller to return during discovery; it does not
program physical zones.

## Join one controller

1. Remove that controller's original CCO USB coordinator from service and keep
   it aside. Keep it unplugged during this migration.
2. Open a short Zigbee2MQTT joining window, preferably through a powered router
   within range of the controller.
3. Follow the CFKL8 reset sequence: hold **Pair for about 15 seconds** until
   the documented G1/G2 reset indication completes, then release.
4. With joining open, briefly press and release the controller's **Reset**
   button. This was the missing step when the reset controller remained at a
   blinking Network Status LED and did not join.
5. Wait for Zigbee2MQTT's successful interview and the controller's steady
   Network Status indication. Confirm its IEEE address and
   `physical_controller_state: ready`.
6. Close joining when the intended controller has joined. Refresh its
   `zone_table` expose to obtain a current table.

Use the controller's buttons and leave its wiring in place. The short Reset
press and the long Pair hold have different effects; do not repeat a factory
reset simply to refresh the zone table.

A brief Pair press displays the assigned controller number as a count of lit
zone LEDs. For example, controller number 2 lit zone LEDs 1 and 2 on the tested
unit. Confirm the number matches the configuration before assigning rooms.

## Join and assign one thermostat

1. Open a short Zigbee2MQTT joining window through the intended CFKL8 or a
   nearby powered router.
2. From the thermostat's normal screen, hold **◀ + ▶ + ✓** for about five
   seconds until `00 / PSw` appears.
3. Select **47** using ▲/▼ and confirm ✓. Confirm the `dEL` and reset prompts
   until `USE / UF H`. The segmented `rES` label can resemble `AE5`.
4. Select/confirm **UF H** for underfloor heating. At `Join`, briefly press ✓
   once and wait for pairing. At `PAir`, press ✓ to continue.
5. At `WC`, select the configured controller number and confirm ✓.
6. Keep the group value **directly below `gr`** at `--` for an independent
   room and confirm ✓. Its other values are groups 1 and 2.
7. Select the recorded physical zone using the **separate right-hand number**
   and confirm ✓. The group `--` field is not the zone number.
8. Wait for the normal temperature screen. Restore the desired target and
   confirm ✓. Close joining after the intended thermostat has joined.

If the actual labels or prompts differ, use the matching manual rather than
confirming unknown settings. Preserve any custom schedules before resetting.

The real thermostat and CFKL8 perform the zone exchange. The converter answers
controller discovery and clock requests; it does not fabricate pairing ACKs.

## Check the result

Refresh the CFKL8 `zone_table` and match the zone's short address to the intended
thermostat in Zigbee2MQTT. Wait at least five seconds between table requests.
Confirm that a target command appears in a fresh thermostat report, then check
the intended physical zone LED in both directions and restore the desired
temperature. Observe pump response separately from the zone LED and allow for
the controller's built-in delay.

Extra profile elements or unusual display behavior were observed temporarily
after commissioning. Some commands were echoed without changing the reported
target during that state. Waiting for a normal screen followed by a fresh
target report resolved the attended tests; no exact timeout or cause is known.

## Manufacturer references

- [CFKL8 quick guide, English](https://www.cosmo-info.de/sites/default/files/products/documents/CFKL8_QG_EN_V003pdf___3f75ad918cc2c8d26c006e13704790d2.pdf)
- [Extended COSMO wireless-system instructions, German](https://www.cosmo-info.de/sites/default/files/products/documents/Erweiterte_Anleitung_CFTN_CFKL8_Funksystempdf___0_pdf_148987_148_2205_3049_.pdf)
- [CFTP/CFTPUP quick guide, English](https://www.cosmo-info.de/sites/default/files/products/documents/CFTPUP_CFTP_QG_EN_V007_2pdf___23d1b61b50e2af7b89c3a3e60bbed09e.pdf)
