// SPDX-License-Identifier: MIT
// COSMO CFTP 2010 / CFKL8 external-converter core. See NOTICE for attribution.
// Only configured devices can match. Native thermostats and controllers own
// zone pairing and heating demand; no reset, mode, raw-write or OTA API is exposed.
import {Zcl} from "zigbee-herdsman";
import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import {logger} from "zigbee-herdsman-converters/lib/logger";

export const THERMOSTAT_ENDPOINT = 9;
export const CONTROLLER_ENDPOINT = 8;
export const CLUSTER = "manuSpecificCosmoCftp";
export const META_KEY = "cosmo_physical_controller_v1";
const SECONDS_1970_TO_2000 = 946684800;
// Native protocol's standard-UTC-offset table, in seconds. See docs/protocol.md.
const TIME_ZONE_OFFSETS = Object.freeze([
    -46800, -43200, -39600, -36000, -32400, -28800, -25200, -21600, -18000, -14400, -10800, -7200, -3600,
    0, 3600, 7200, 10800, 14400, 18000, 21600, 25200, 28800, 32400, 36000, 39600, 43200, 46800, 50400,
    -34200, -16200, -12600, -11220, 12600, 16200, 19800, 20700, 23400, 31500, 34200, 37800, 41400, 45900,
]);

function assertRecord(value, allowedKeys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be an object`);
    const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
    if (unknown.length) throw new TypeError(`${label} contains unknown keys: ${unknown.join(", ")}`);
}
function normalizeIeee(value) {
    if (typeof value !== "string" || !/^0x[0-9a-f]{16}$/i.test(value)) throw new TypeError("IEEE addresses must have 0x followed by 16 hexadecimal digits");
    const ieee = value.toLowerCase();
    if (["0x0000000000000000", "0xffffffffffffffff"].includes(ieee)) throw new TypeError("IEEE addresses cannot be all zeroes or all ones");
    return ieee;
}
function makeClockFormatter(timeZone) {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
}
function clockOffsetSeconds(formatter, now) {
    const parts = Object.fromEntries(formatter.formatToParts(now).map(({type, value}) => [type, value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second)) / 1000 - Math.floor(now.getTime() / 1000);
}
function normalizeClock(value) {
    assertRecord(value, ["timeZone", "standardUtcOffsetMinutes", "daylightSavingOffsetMinutes"], "clock");
    if (typeof value.timeZone !== "string" || value.timeZone.length === 0 || /^[+-]/.test(value.timeZone)) throw new TypeError("clock.timeZone must be an explicit IANA time-zone name");
    let formatter;
    try {formatter = makeClockFormatter(value.timeZone);} catch {throw new TypeError("clock.timeZone is not a valid IANA time-zone name");}
    if (!Number.isInteger(value.standardUtcOffsetMinutes) || !TIME_ZONE_OFFSETS.includes(value.standardUtcOffsetMinutes * 60)) {
        throw new TypeError("clock.standardUtcOffsetMinutes must exactly match a supported native UTC offset");
    }
    if (![0, 60].includes(value.daylightSavingOffsetMinutes)) throw new TypeError("clock.daylightSavingOffsetMinutes must be 0 or 60");
    const standard = value.standardUtcOffsetMinutes * 60;
    const daylight = value.daylightSavingOffsetMinutes * 60;
    // Configuration errors should fail before the file is installed. Sampling
    // both upcoming years catches ordinary northern/southern seasonal offsets;
    // each synchronization response also checks the actual offset at runtime.
    const year = new Date().getUTCFullYear();
    const observedOffsets = new Set();
    for (let y = year; y <= year + 1; y++) for (let month = 0; month < 12; month++) {
        const actual = clockOffsetSeconds(formatter, new Date(Date.UTC(y, month, 15, 12)));
        observedOffsets.add(actual);
        if (actual !== standard && actual !== standard + daylight) {
            throw new RangeError("clock standard/DST offsets do not match the configured time zone");
        }
    }
    if (!observedOffsets.has(standard) || daylight !== 0 && !observedOffsets.has(standard + daylight)) {
        throw new RangeError("clock standard/DST offsets do not match the configured time zone");
    }
    return Object.freeze({timeZone: value.timeZone, standardUtcOffsetMinutes: value.standardUtcOffsetMinutes,
        daylightSavingOffsetMinutes: value.daylightSavingOffsetMinutes});
}
function normalizeController(value) {
    assertRecord(value, ["controllerIeee", "thermostatIeees", "wcNumber"], "controller");
    if (![1, 2].includes(value.wcNumber)) throw new TypeError("Only verified controller numbers WC1 and WC2 are supported");
    const controllerIeee = normalizeIeee(value.controllerIeee);
    if (!Array.isArray(value.thermostatIeees) || value.thermostatIeees.length === 0) throw new TypeError("Each controller requires at least one thermostat IEEE");
    const thermostatIeees = Array.from(value.thermostatIeees, normalizeIeee);
    if (new Set(thermostatIeees).size !== thermostatIeees.length || thermostatIeees.includes(controllerIeee)) {
        throw new TypeError("Controller and thermostat IEEE addresses must be distinct");
    }
    return Object.freeze({controllerIeee, thermostatIeees: Object.freeze(thermostatIeees), wcNumber: value.wcNumber});
}
export function normalizeConfiguration(config) {
    assertRecord(config, ["clock", "controllers"], "configuration");
    const clock = normalizeClock(config.clock);
    if (!Array.isArray(config.controllers) || config.controllers.length === 0) throw new TypeError("controllers must be a nonempty array");
    const controllers = config.controllers.map(normalizeController);
    const addresses = new Set(), numbers = new Set();
    for (const controller of controllers) {
        if (numbers.has(controller.wcNumber)) throw new TypeError("Controller WC numbers must be unique across the configuration");
        numbers.add(controller.wcNumber);
        for (const ieee of [controller.controllerIeee, ...controller.thermostatIeees]) {
            if (addresses.has(ieee)) throw new TypeError("IEEE addresses cannot appear in more than one configured installation");
            addresses.add(ieee);
        }
    }
    return Object.freeze({clock, controllers: Object.freeze(controllers)});
}
export function createConverter(config) {
    const normalized = normalizeConfiguration(config);
    return normalized.controllers.flatMap((controller) => createInstallation({...controller, clock: normalized.clock}).definitions);
}

// Each installation owns its controller number, configured thermostat list and
// in-flight state; lookups cannot fall back to another installation.
export function createInstallation(options) {
    assertRecord(options, ["controllerIeee", "thermostatIeees", "wcNumber", "clock"], "installation");
    const {clock: inputClock, ...controllerOptions} = options;
    const clock = normalizeClock(inputClock);
    const {controllerIeee, thermostatIeees, wcNumber} = normalizeController(controllerOptions);
    const CONTROLLER_IEEE = controllerIeee;
    const THERMOSTAT_IEEES = thermostatIeees;

    const NS = "zhc:cosmo_physical_controller";
    const MANUFACTURER = 0x1078;
    const REPLY_INTERVAL_MS = 1000;
    const QUERY_INTERVAL_MS = 5000;
    const OFFER_WINDOW_MS = 120000;
    // Only controller numbers whose ACKs have been observed are supported.
    // Acceptance still requires a matching fresh successful offer.
    const observedSyncAckHex = Object.freeze({1: "110000", 2: "120000"})[wcNumber];
    const lastSync = new Map();
    const lastLookup = new Map();
    const lastAck = new Map();
    const lastQuery = new Map();
    const handles = new Map();
    const zoneTables = new Map();
    const pendingSaves = new WeakMap();
    let controllerEpoch = 0;
    let controllerOffer;
    let controllerStopped = false;

    const sameIeee = (value, expected) => typeof value === "string" && value.toLowerCase() === expected;
    const isThermostat = (device) => THERMOSTAT_IEEES.some((ieee) => sameIeee(device?.ieeeAddr, ieee));
    const isController = (device) => sameIeee(device?.ieeeAddr, CONTROLLER_IEEE);
    const isAllowed = (device) => isThermostat(device) || isController(device);
    const unicast = (value) => Number.isInteger(value) && value > 0 && value <= 0xfff7;
    const hexAddress = (value) => `0x${value.toString(16).padStart(4, "0")}`;

    function validateControllerSignature(device) {
        if (!isController(device) || device.isDeleted === true || device.type !== "Router" || device.manufacturerName !== "Computime" ||
            device.manufacturerID !== MANUFACTURER || typeof device.getEndpoint !== "function" ||
            typeof device.addCustomCluster !== "function" || typeof device.save !== "function" || !unicast(device.networkAddress)) return false;
        const endpoint = device.getEndpoint(CONTROLLER_ENDPOINT);
        return endpoint?.ID === CONTROLLER_ENDPOINT && endpoint.profileID === 260 &&
            sameIeee(endpoint.deviceIeeeAddress, CONTROLLER_IEEE) &&
            endpoint.deviceNetworkAddress === device.networkAddress &&
            Array.isArray(endpoint.inputClusters) && endpoint.inputClusters.includes(0xfc00);
    }

    function lookupDevice(context, ieee) {
        try {return context?.constructor?.byIeeeAddr?.(ieee);} catch {return undefined;}
    }
    function findPhysicalController(context) {
        const device = lookupDevice(context, CONTROLLER_IEEE);
        return !controllerStopped && validateControllerSignature(device) ? device : undefined;
    }
    function acceptedControllerNumber(device) {
        const record = device?.meta?.[META_KEY];
        return validateControllerSignature(device) && !pendingSaves.has(device) &&
            record?.version === 1 && record.ieee === CONTROLLER_IEEE && record.accepted === true && record.wc_number === wcNumber &&
            [...(observedSyncAckHex !== undefined ? ["sync_ack"] : []), `request_number_${wcNumber}`].includes(record.accepted_by);
    }
    async function saveControllerMeta(device, patch) {
        const token = {};
        pendingSaves.set(device, token);
        device.meta ||= {};
        const record = {...device.meta[META_KEY], ...patch, version: 1, ieee: CONTROLLER_IEEE, wc_number: wcNumber};
        device.meta[META_KEY] = record;
        try {await device.save();} catch (error) {
            if (device.meta[META_KEY] === record) device.meta[META_KEY] = {...record, accepted: false, reason: "metadata_save_failed"};
            throw error;
        } finally {if (pendingSaves.get(device) === token) pendingSaves.delete(device);}
    }
    async function invalidateController(device, reason) {
        controllerEpoch++;
        controllerOffer = undefined;
        zoneTables.delete(CONTROLLER_IEEE);
        if (isController(device) && device.isDeleted !== true && lookupDevice(device, CONTROLLER_IEEE) === device) await saveControllerMeta(device, {accepted: false, reason});
    }

    function controllerDiagnostics(context) {
        const known = lookupDevice(context, CONTROLLER_IEEE);
        const controller = validateControllerSignature(known) ? known : undefined;
        const ready = controller && !controllerStopped ? acceptedControllerNumber(controller) : false;
        const record = controller?.meta?.[META_KEY];
        const table = zoneTables.get(CONTROLLER_IEEE);
        const thermostats = isThermostat(context) ? [context] : THERMOSTAT_IEEES.map((ieee) => lookupDevice(context, ieee)).filter(isThermostat);
        const currentTable = ready && table?.device === controller && table.address === controller.networkAddress;
        const paired = currentTable
            ? table.slots.slice(0, 8).map((slot, index) => thermostats.some((thermostat) => unicast(thermostat.networkAddress) && slot.address === thermostat.networkAddress) ? index + 1 : null).filter(Boolean) : [];
        return {
            physical_controller_present: Boolean(controller),
            physical_controller_sync_seen: Boolean(record?.last_sync_seen || record?.last_sync_ack),
            physical_controller_slot_verified: Boolean(ready),
            physical_controller_state: !known ? "absent" : !controller ? "invalid_signature" : controllerStopped ? "stopped" : ready ? "ready" : "present_unverified_slot",
            physical_zone_pairing_verified: paired.length > 0,
            physical_zone_table_current: Boolean(currentTable),
            physical_paired_zones: paired.join(","),
        };
    }

    const clockFormatter = makeClockFormatter(clock.timeZone);
    function syncPayload(now = new Date(), deviceNumber = 0x20) {
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("Invalid synchronization date");
        const offset = clockOffsetSeconds(clockFormatter, now);
        const standardOffset = clock.standardUtcOffsetMinutes * 60;
        const daylightOffset = clock.daylightSavingOffsetMinutes * 60;
        if (offset !== standardOffset && offset !== standardOffset + daylightOffset) {
            throw new RangeError("Time-zone offset does not match the configured standard/DST offsets");
        }
        const seconds = Math.floor(now.getTime() / 1000) + offset - SECONDS_1970_TO_2000;
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffffffff) throw new RangeError("Clock outside Salus range");
        if (![wcNumber, 0x20].includes(deviceNumber)) throw new RangeError("Unsupported COSMO device number");
        const payload = Buffer.alloc(15);
        payload[0] = deviceNumber;
        payload.writeUInt32LE(seconds, 2);
        payload[6] = 0x02 | (offset > standardOffset ? 1 : 0);
        payload[7] = TIME_ZONE_OFFSETS.indexOf(standardOffset);
        payload[8] = clock.daylightSavingOffsetMinutes / 60;
        payload.fill(0xff, 9, 13);
        payload[13] = 0x31;
        return payload;
    }

    const rawParameter = [{name: "payload", type: Zcl.BuffaloZclDataType.BUFFER}];
    const commandIds = {
        syncRequest: 0x10, zoneReport: 0x12, pairConfirm: 0x14, wiringCentreRequest: 0x16,
        command17: 0x17, pairRequest: 0x18, replacedThermostat: 0x1a,
        record: 0x31, write: 0x32, echo: 0x33, syncAck: 0x37,
        syncResponse: 0x81, command83: 0x83, pairDone: 0x84, wiringCentreResponse: 0x86, pairAck: 0x88,
    };
    const commands = Object.fromEntries(Object.entries(commandIds).map(([name, ID]) => [name, {name, ID, parameters: rawParameter}]));
    const clusterDefinition = {name: CLUSTER, ID: 0xfc00, manufacturerCode: MANUFACTURER, attributes: {}, commands, commandsResponse: commands};
    const gatewayBasic = {
        name: "genBasic", ID: 0,
        attributes: {
            manufacturerName: {name: "manufacturerName", ID: 4, type: Zcl.DataType.CHAR_STR, default: "Computime", maxLen: 32},
            modelId: {name: "modelId", ID: 5, type: Zcl.DataType.CHAR_STR, default: "SAU2AG1", maxLen: 32},
        }, commands: {}, commandsResponse: {},
    };
    function registerClusters(device) {
        if (!isAllowed(device) || typeof device.addCustomCluster !== "function") return;
        device.addCustomCluster(CLUSTER, clusterDefinition);
        device.addCustomCluster("genBasic", gatewayBasic);
    }
    function parseRawFrame(data) {
        if (!Buffer.isBuffer(data) || data.length < 5 || (data[0] & 3) !== 1 || !(data[0] & 4) || data.readUInt16LE(1) !== MANUFACTURER) return;
        return {command: data[4], payload: data.subarray(5), frameHex: data.toString("hex")};
    }
    function decodedMessage(msg) {
        const expected = isController(msg?.device) ? CONTROLLER_ENDPOINT : THERMOSTAT_ENDPOINT;
        if (!isAllowed(msg?.device) || msg.endpoint?.ID !== expected || !sameIeee(msg.endpoint.deviceIeeeAddress, msg.device.ieeeAddr.toLowerCase())) return;
        if (msg.type === "raw") return parseRawFrame(msg.data);
        const command = Object.entries(commandIds).find(([name]) => msg.type === `command${name[0].toUpperCase()}${name.slice(1)}`)?.[1];
        if (command === undefined || !Buffer.isBuffer(msg.data?.payload)) return;
        return {command, payload: msg.data.payload};
    }
    function decodeLegacyStatus(payload) {
        if (!Buffer.isBuffer(payload) || payload.length !== 77) return undefined;
        const tag = payload[0] & 0x7f;
        if (tag === 0 || tag >= 0x60 || ![0x01, 0x03, 0x0d, 0x0e].includes(payload[1] & 0x0f)) return undefined;
        // Legacy status subtypes 1, 3, D and E share temperature bytes 2/3.
        // Decode only the verified live prefix; mode/schedule bodies and
        // newer SQ610 records remain outside this implementation.
        const localByte = payload[2];
        return {
            local_temperature: localByte === 0x7b || localByte === 0x7d ? null : (localByte - 32) * 0.5,
            reported_heating_setpoint: (payload[3] - 32) * 0.5,
            heating_setpoint: (payload[3] - 32) * 0.5,
        };
    }


    const zoneHeatingKeys = Array.from({length: 8}, (_, index) => `zone_${index + 1}_heating`);
    const unknownZoneHeating = () => Object.fromEntries(zoneHeatingKeys.map((key) => [key, null]));
    function zoneHeating(slot) {
        // Bit 0x08 tracked the zone LED in an attended OFF/ON/OFF trial.
        // Decode only the observed flag forms; unknown and empty slots are unknown.
        return slot.address !== null && [0x04, 0x0c, 0xf4, 0xfc].includes(slot.flag)
            ? Boolean(slot.flag & 0x08) : null;
    }

    function parseZoneTable(payload) {
        // Full B70 layout: handle + B70 + 55 bytes. The native reference uses
        // a magic trailer; this CFKL8 has also reported a zero-filled trailer
        // ending in 0x78 on the same firmware. Accept only those two exact trailers; do not guess
        // offsets for truncated tables, unknown zone counts or other reports.
        if (!Buffer.isBuffer(payload) || payload.length !== 59 || payload.subarray(1, 4).toString("latin1") !== "B70" || payload[9] !== 8 ||
            !payload.subarray(4, 9).equals(Buffer.alloc(5)) || payload[48] !== 0 ||
            !["7eaaaaa8800000000078", "00000000000000000078"].some((trailer) => payload.subarray(49).equals(Buffer.from(trailer, "hex")))) return;
        const slots = [];
        for (let index = 0; index < 12; index++) {
            const address = payload.readUInt16BE(10 + index * 3);
            if (address !== 0xffff && (address < 0 || address > 0xfff7)) return;
            slots.push({address: address === 0xffff ? null : address, flag: payload[12 + index * 3]});
        }
        return {slots, lqi: payload[46], rssi: payload.readInt8(47)};
    }
    function nextHandle(ieee, maximum) {
        const value = ((handles.get(ieee) || 0) % maximum) + 1;
        handles.set(ieee, value);
        return value;
    }
    function permitReply(map, ieee, now, interval = REPLY_INTERVAL_MS) {
        const at = now.getTime();
        if (map.has(ieee) && at - map.get(ieee) < interval) return false;
        map.set(ieee, at);
        return true;
    }
    async function respond(device, endpoint, command, payload) {
        registerClusters(device);
        const commandHex = `0x${commandIds[command].toString(16).padStart(2, "0")}`;
        try {
            await endpoint.commandResponse(CLUSTER, command, {payload}, {
                manufacturerCode: MANUFACTURER, disableDefaultResponse: true,
                direction: Zcl.Direction.SERVER_TO_CLIENT, srcEndpoint: 1, sendPolicy: "immediate",
            });
            logger.debug(`TX ${device.ieeeAddr.toLowerCase()} source_ep=1 destination_ep=${endpoint.ID} command=${commandHex} payload=${payload.toString("hex")} phase=sent`, NS);
        } catch (error) {
            logger.warning(`COSMO command ${commandHex} could not be sent to endpoint ${endpoint.ID}`, NS);
            throw error;
        }
    }
    async function offerControllerSync(device, now, source, epoch = controllerEpoch, allowDeferredReply = false) {
        const currentDevice = () => controllerEpoch === epoch && findPhysicalController(device) === device;
        if (!currentDevice()) return;
        if (!permitReply(lastSync, CONTROLLER_IEEE, now)) {
            if (!allowDeferredReply) return;
            // One bounded reply to this actual greeting, not a poll. It supersedes
            // an earlier lifecycle offer without bypassing the one-second throttle.
            const delay = Math.max(1, Math.min(REPLY_INTERVAL_MS, REPLY_INTERVAL_MS - (now.getTime() - lastSync.get(CONTROLLER_IEEE))));
            await new Promise((resolve) => setTimeout(resolve, delay));
            now = new Date(now.getTime() + delay);
            if (!currentDevice() || !permitReply(lastSync, CONTROLLER_IEEE, now)) return;
        }
        if (!currentDevice()) return;
        let settle;
        const success = new Promise((resolve) => {settle = resolve;});
        const offer = {epoch: controllerEpoch, device, at: now.getTime(), success};
        controllerOffer = offer;
        const current = () => controllerOffer === offer && controllerEpoch === offer.epoch;
        try {
            const payload = syncPayload(now, wcNumber);
            await respond(device, device.getEndpoint(CONTROLLER_ENDPOINT), "syncResponse", payload);
            if (current()) {
                await saveControllerMeta(device, {last_offer_sent: now.toISOString()});
                settle(current());
            } else settle(false);
            logger.info(`WC${wcNumber} sync offered ${CONTROLLER_IEEE} source=${source} sent_not_acceptance=true`, NS);
            return "sent";
        } catch (error) {
            settle(false);
            logger.warning(`WC${wcNumber} sync offer failed ${CONTROLLER_IEEE}: ${error?.message ?? String(error)}`, NS);
            return "failed";
        }
    }

    async function handleMessage(msg, now = new Date()) {
        const frame = decodedMessage(msg);
        if (!frame) return;
        const ieee = msg.device.ieeeAddr.toLowerCase();
        const raw = Buffer.isBuffer(msg.meta?.rawData) ? msg.meta.rawData.toString("hex") : frame.frameHex;
        logger.debug(`RX ${ieee} ep=${msg.endpoint.ID} command=0x${frame.command.toString(16)} payload=${frame.payload.toString("hex")}${raw ? ` frame=${raw}` : ""} metadata=${JSON.stringify({at: now.toISOString(), tsn: msg.meta?.zclTransactionSequenceNumber, frame_control: msg.meta?.frameControl, group_id: msg.groupID, linkquality: msg.linkquality})}`, NS);
        const state = {last_command: `0x${frame.command.toString(16).padStart(2, "0")}`, last_payload: frame.payload.toString("hex"), protocol_last_seen: now.toISOString()};
        if (isController(msg.device)) {
            if (!validateControllerSignature(msg.device)) {
                try {await invalidateController(msg.device, "invalid_signature");} catch {}
                return {...state, ...controllerDiagnostics(msg.device)};
            }
            if (lookupDevice(msg.device, CONTROLLER_IEEE) !== msg.device || controllerStopped && frame.command !== 0x10) return {...state, ...controllerDiagnostics(msg.device)};
            if (frame.command === 0x10 && frame.payload.length === 7) {
                controllerStopped = false;
                const epoch = ++controllerEpoch;
                controllerOffer = undefined;
                if (frame.payload[0] !== wcNumber) {
                    zoneTables.delete(CONTROLLER_IEEE);
                    Object.assign(state, unknownZoneHeating());
                }
                try {
                    await saveControllerMeta(msg.device, {accepted: frame.payload[0] === wcNumber,
                        accepted_by: frame.payload[0] === wcNumber ? `request_number_${wcNumber}` : undefined,
                        reason: frame.payload[0] === wcNumber ? "verified_request" : "unassigned_or_other_number",
                        last_sync_seen: now.toISOString(), requested_number: frame.payload[0]});
                    if (controllerEpoch === epoch) state.sync_response = await offerControllerSync(msg.device, now, "sync_request", epoch, true);
                } catch (error) {logger.warning(`WC${wcNumber} metadata update failed: ${error?.message ?? String(error)}`, NS);}
            } else if (frame.command === 0x37 && observedSyncAckHex !== undefined && frame.payload.equals(Buffer.from(observedSyncAckHex, "hex"))) {
                state.controller_sync_ack_seen = true;
                const offer = controllerOffer;
                if (offer?.device === msg.device && offer.epoch === controllerEpoch && now.getTime() >= offer.at && now.getTime() - offer.at <= OFFER_WINDOW_MS && permitReply(lastAck, CONTROLLER_IEEE, now)) {
                    if (await offer.success && controllerOffer === offer && controllerEpoch === offer.epoch && validateControllerSignature(msg.device)) {
                        try {await saveControllerMeta(msg.device, {accepted: true, accepted_by: "sync_ack", reason: "verified_ack", last_sync_ack: now.toISOString()});}
                        catch (error) {logger.warning(`WC${wcNumber} accepted-state save failed: ${error?.message ?? String(error)}`, NS);}
                    }
                }
            } else if (frame.command === 0x33) {
                const table = parseZoneTable(frame.payload);
                if (table) {
                    zoneTables.set(CONTROLLER_IEEE, {...table, device: msg.device, address: msg.device.networkAddress, seen: now.toISOString()});
                    state.zone_table = JSON.stringify(table.slots.slice(0, 8).map((slot) => slot.address === null ? null : hexAddress(slot.address)));
                    state.zone_table_valid = true;
                    state.zone_table_seen = now.toISOString();
                    state.controller_lqi = table.lqi;
                    state.controller_rssi = table.rssi;
                    for (let i = 0; i < 8; i++) {
                        state[`zone_${i + 1}`] = table.slots[i].address === null ? null : hexAddress(table.slots[i].address);
                        state[`zone_${i + 1}_flag`] = table.slots[i].flag;
                        state[zoneHeatingKeys[i]] = zoneHeating(table.slots[i]);
                    }
                } else if (frame.payload.subarray(1, 4).toString("latin1") === "B70") {
                    zoneTables.delete(CONTROLLER_IEEE);
                    state.zone_table_valid = false;
                    Object.assign(state, unknownZoneHeating());
                }
            }
            return {...state, ...controllerDiagnostics(msg.device)};
        }
        if (frame.command === 0x31) Object.assign(state, decodeLegacyStatus(frame.payload));
        if (frame.command === 0x33) {state.last_write_echo = frame.payload.toString("hex"); state.last_write_echo_seen = now.toISOString();}
        if (frame.command === 0x10 && frame.payload.length === 7 && permitReply(lastSync, ieee, now)) {
            try {await respond(msg.device, msg.endpoint, "syncResponse", syncPayload(now, 0x20)); state.sync_response = "sent";}
            catch (error) {state.sync_response = "failed"; logger.warning(`Thermostat sync reply failed: ${error?.message ?? String(error)}`, NS);}
        }
        if (frame.command === 0x16 && frame.payload.length === 1 && frame.payload[0] >= 1 && frame.payload[0] <= 9 && permitReply(lastLookup, ieee, now)) {
            const controller = findPhysicalController(msg.device);
            const found = frame.payload[0] === wcNumber && controller && acceptedControllerNumber(controller);
            const payload = Buffer.from([found ? 1 : 0, 0xff, 0xff]);
            if (found) payload.writeUInt16LE(controller.networkAddress, 1);
            try {await respond(msg.device, msg.endpoint, "wiringCentreResponse", payload); state.wiring_centre_response = found ? "physical_controller_found" : "not_found";}
            catch (error) {state.wiring_centre_response = "failed"; logger.warning(`Physical WC lookup reply failed: ${error?.message ?? String(error)}`, NS);}
        }
        // 0x18/0x14/0x12 are never acknowledged or synthesized here. The real
        // thermostat and real controller own their direct zone relationship.
        return {...state, ...controllerDiagnostics(msg.device)};
    }

    const heatingSetpoint = {
        key: ["heating_setpoint"],
        convertSet: async (entity, key, value, meta) => {
            if (key !== "heating_setpoint" || typeof value !== "number" || !Number.isFinite(value) || value < 5 || value > 35 || !Number.isInteger(value * 2)) throw new Error("Heating setpoint must be 5 to 35 °C in 0.5 °C steps");
            if (!isThermostat(meta?.device) || entity?.ID !== THERMOSTAT_ENDPOINT || !sameIeee(entity.deviceIeeeAddress, meta.device.ieeeAddr.toLowerCase()) || typeof entity.commandResponse !== "function" || typeof meta.device.addCustomCluster !== "function") throw new Error("Heating control requires the selected thermostat endpoint");
            const controller = findPhysicalController(meta.device);
            if (!controller || !acceptedControllerNumber(controller)) throw new Error(`Physical WC${wcNumber} is absent, invalid or has no verified controller number`);
            const payload = Buffer.from([nextHandle(meta.device.ieeeAddr.toLowerCase(), 255), 0x42, 0x33, 0x34, value * 2 + 32]);
            await respond(meta.device, entity, "write", payload);
            logger.info(`Heating target write sent ${meta.device.ieeeAddr.toLowerCase()} awaiting_status=true`, NS);
        },
    };
    const zoneTableQuery = {
        key: ["zone_table", ...zoneHeatingKeys],
        convertGet: async (entity, key, meta) => {
            if (!["zone_table", ...zoneHeatingKeys].includes(key) || !validateControllerSignature(meta?.device) || entity !== meta.device.getEndpoint(CONTROLLER_ENDPOINT) || findPhysicalController(meta.device) !== meta.device) throw new Error("Zone query requires the exact validated physical controller endpoint");
            const now = new Date();
            if (!permitReply(lastQuery, CONTROLLER_IEEE, now, QUERY_INTERVAL_MS)) throw new Error("Wait five seconds before another zone-table query");
            const payload = Buffer.concat([Buffer.from([nextHandle(CONTROLLER_IEEE, 127)]), Buffer.from("4237307eaaaaa88000000078", "hex")]);
            await respond(meta.device, entity, "write", payload);
            logger.info(`WC${wcNumber} B70 queried ${CONTROLLER_IEEE}`, NS);
        },
    };

    function clearProbeState() {
        controllerEpoch++;
        controllerOffer = undefined;
        controllerStopped = false;
        lastSync.clear(); lastLookup.clear(); lastAck.clear(); lastQuery.clear(); handles.clear(); zoneTables.clear();
    }
    async function handleLifecycle(event, now = new Date()) {
        const data = event?.data || {};
        const device = data.device;
        const ieee = data.ieeeAddr || device?.ieeeAddr;
        if (event?.type === "stop") {
            if (sameIeee(ieee, CONTROLLER_IEEE)) {
                // Actual Z2M leave/removal also arrives as stop. The SDK removes
                // its DB row and clears meta before emitting it; byIeeeAddr hides
                // deleted objects. Never save metadata back onto a removed object.
                clearProbeState();
                controllerStopped = true;
            } else if (typeof ieee === "string" && THERMOSTAT_IEEES.includes(ieee.toLowerCase())) {
                lastSync.delete(ieee.toLowerCase()); lastLookup.delete(ieee.toLowerCase()); handles.delete(ieee.toLowerCase());
            }
            return;
        }
        if (!isAllowed(device)) return;
        registerClusters(device);
        const currentController = validateControllerSignature(device) && lookupDevice(device, CONTROLLER_IEEE) === device;
        if (currentController && event.type === "start") controllerStopped = false;
        if (currentController && (event.type === "deviceAnnounce" || event.type === "deviceInterview" && data.status === "successful")) {
            controllerStopped = false;
            await offerControllerSync(device, now, event.type);
        }
    }

    const fz = {cluster: CLUSTER, type: ["raw", ...Object.keys(commandIds).map((name) => `command${name[0].toUpperCase()}${name.slice(1)}`)], convert: async (_model, msg) => handleMessage(msg)};
    const diagnosticExposes = () => [
        exposes.presets.binary("physical_controller_present", exposes.access.STATE, true, false),
        exposes.presets.binary("physical_controller_sync_seen", exposes.access.STATE, true, false),
        exposes.presets.binary("physical_controller_slot_verified", exposes.access.STATE, true, false),
        exposes.presets.binary("physical_zone_pairing_verified", exposes.access.STATE, true, false)
            .withDescription("Known controller table contains this approved thermostat; physical heating operation still needs verification"),
        exposes.presets.binary("physical_zone_table_current", exposes.access.STATE, true, false),
        exposes.presets.text("physical_controller_state", exposes.access.STATE),
        exposes.presets.text("physical_paired_zones", exposes.access.STATE),
        exposes.presets.text("last_command", exposes.access.STATE),
        exposes.presets.text("last_payload", exposes.access.STATE),
        exposes.presets.text("protocol_last_seen", exposes.access.STATE),
    ].map((expose) => expose.withCategory("diagnostic"));
    const fingerprint = (ieee, models) => models.map((modelID) => ({...(modelID === undefined ? {} : {modelID}), ieeeAddr: new RegExp(`^${ieee}$`, "i"), priority: 100}));
    const thermostat = {
        fingerprint: THERMOSTAT_IEEES.flatMap((ieee) => fingerprint(ieee, [undefined, "SAL6ET1", "SAL6ET1GC", "CFTP", "CFTP2010"])) ,
        model: `CFTP-2010-WC${wcNumber}`, vendor: "COSMO",
        description: `Configured CFTP 2010; requires its physical CFKL8 with verified WC${wcNumber} number and native physical zone pairing`,
        endpoint: () => ({default: THERMOSTAT_ENDPOINT}), fromZigbee: [fz], toZigbee: [heatingSetpoint],
        exposes: [
            exposes.presets.numeric("heating_setpoint", exposes.access.STATE_SET).withUnit("°C").withValueMin(5).withValueMax(35).withValueStep(0.5),
            exposes.presets.numeric("reported_heating_setpoint", exposes.access.STATE).withUnit("°C"),
            exposes.presets.numeric("local_temperature", exposes.access.STATE).withUnit("°C"),
            exposes.presets.text("last_write_echo", exposes.access.STATE).withCategory("diagnostic"),
            exposes.presets.text("last_write_echo_seen", exposes.access.STATE).withCategory("diagnostic"),
            ...diagnosticExposes(),
        ],
        configure: async (device) => registerClusters(device), onEvent: handleLifecycle,
    };
    const controller = {
        fingerprint: fingerprint(CONTROLLER_IEEE, [undefined, "it600WC", "KL08RF", "CFKL8", "SAL6DW1", "SAL6DI1"]),
        model: `CFKL8-WC${wcNumber}`, vendor: "COSMO",
        description: `Configured CFKL8: WC${wcNumber} sync and read-only zone table; native physical zone pairing`,
        endpoint: () => ({default: CONTROLLER_ENDPOINT}), fromZigbee: [fz], toZigbee: [zoneTableQuery],
        exposes: [
            exposes.presets.text("zone_table", exposes.access.STATE_GET).withDescription("Refresh the read-only B70 zone snapshot, including zone heating indications"),
            exposes.presets.text("zone_table_seen", exposes.access.STATE).withLabel("Zone snapshot time")
                .withDescription("Time of the last valid zone snapshot; heating indications stay at that snapshot until refreshed"),
            exposes.presets.binary("zone_table_valid", exposes.access.STATE, true, false),
            exposes.presets.numeric("controller_lqi", exposes.access.STATE),
            exposes.presets.numeric("controller_rssi", exposes.access.STATE).withUnit("dBm"),
            ...Array.from({length: 8}, (_, index) => [
                exposes.presets.binary(zoneHeatingKeys[index], exposes.access.STATE_GET, true, false)
                    .withLabel(`Zone ${index + 1} heating`),
                exposes.presets.text(`zone_${index + 1}`, exposes.access.STATE),
                exposes.presets.numeric(`zone_${index + 1}_flag`, exposes.access.STATE).withCategory("diagnostic"),
            ]).flat(),
            ...diagnosticExposes(),
        ],
        configure: async (device) => registerClusters(device), onEvent: handleLifecycle,
    };

    return Object.freeze({
        controllerIeee: CONTROLLER_IEEE, thermostatIeees: THERMOSTAT_IEEES, wcNumber,
        definitions: [thermostat, controller],
        isThermostat, isController, validateControllerSignature, findPhysicalController,
        controllerDiagnostics, registerClusters, handleMessage, handleLifecycle,
        clearState: clearProbeState, clearProbeState, decodeLegacyStatus, parseZoneTable, syncPayload, parseRawFrame,
    });
}
