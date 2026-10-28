// SPDX-License-Identifier: MIT
// Offline protocol tests. The fake endpoint serializes SDK ZCL frames but never
// constructs an adapter or accesses an actual Zigbee network.
import assert from "node:assert/strict";
import {beforeEach, test} from "node:test";
import {Zcl} from "zigbee-herdsman";
import {createRequire} from "node:module";
import path from "node:path";
import {CLUSTER, META_KEY, createInstallation} from "../src/converter.mjs";

// All addresses, dates and record bodies in this suite are synthetic.
const clock = Object.freeze({timeZone: "Europe/Berlin", standardUtcOffsetMinutes: 60, daylightSavingOffsetMinutes: 60});
const CONTROLLER_IEEE = "0x0200000000000001";
const THERMOSTAT_IEEE = "0x0200000000000011";
const THERMOSTAT_IEEES = Object.freeze([THERMOSTAT_IEEE, "0x0200000000000012", "0x0200000000000013"]);
const first = createInstallation({controllerIeee: CONTROLLER_IEEE, thermostatIeees: THERMOSTAT_IEEES, wcNumber: 1, clock});
const {
    isThermostat, validateControllerSignature, findPhysicalController,
    controllerDiagnostics, registerClusters, handleMessage, handleLifecycle,
    clearProbeState, decodeLegacyStatus, parseZoneTable, syncPayload,
} = first;
const now = new Date("2030-01-15T12:00:00.000Z");
const groundControllerIeee = "0x0200000000000002";
const groundThermostatIeees = ["0x0200000000000021", "0x0200000000000022", "0x0200000000000023"];
const ground = createInstallation({controllerIeee: groundControllerIeee, thermostatIeees: groundThermostatIeees, wcNumber: 2, clock});
const definitions = [...first.definitions, ...ground.definitions];
const [thermostatDefinition, controllerDefinition] = first.definitions;
const [groundThermostatDefinition, groundControllerDefinition] = ground.definitions;
class FakeDevice {
    static registry = new Map();
    static byIeeeAddr(ieee) {return this.registry.get(ieee.toLowerCase());}
    constructor(ieee, type, endpointId, networkAddress) {
        this.ieeeAddr = ieee; this.type = type; this.networkAddress = networkAddress;
        this.manufacturerName = "Computime"; this.manufacturerID = 0x1078;
        this.meta = {}; this.customClusters = {}; this.registrations = []; this.tx = []; this.saves = [];
        this.endpoint = {
            ID: endpointId, profileID: 260, deviceIeeeAddress: ieee, deviceNetworkAddress: networkAddress,
            inputClusters: [0, 0xfc00],
            commandResponse: async (cluster, command, payload, options) => {
                const frame = Zcl.Frame.create(Zcl.FrameType.SPECIFIC, options.direction,
                    options.disableDefaultResponse, options.manufacturerCode, 0x44,
                    command, cluster, payload, this.customClusters);
                const sent = {cluster, command, payload: Buffer.from(payload.payload), options, bytes: frame.toBuffer()};
                this.tx.push(sent);
                await this.onSend?.(sent);
            },
            command: async () => {throw new Error("Unexpected client-to-server command");},
        };
        FakeDevice.registry.set(ieee.toLowerCase(), this);
    }
    getEndpoint(id) {return this.endpoint.ID === id ? this.endpoint : undefined;}
    addCustomCluster(name, cluster) {this.registrations.push(name); this.customClusters[name] = cluster;}
    save() {this.saves.push(JSON.parse(JSON.stringify(this.meta))); return this.onSave?.();}
}
function fixture() {
    const controller = new FakeDevice(CONTROLLER_IEEE, "Router", 8, 0x4567);
    const thermostat = new FakeDevice(THERMOSTAT_IEEE, "EndDevice", 9, 0x1234);
    registerClusters(controller); registerClusters(thermostat);
    return {controller, thermostat};
}
function accepted(controller, wcNumber = 1) {
    controller.meta[META_KEY] = {version: 1, ieee: controller.ieeeAddr.toLowerCase(), wc_number: wcNumber, accepted: true,
        accepted_by: `request_number_${wcNumber}`, last_sync_seen: now.toISOString()};
}
function twoFloors() {
    const upstairs = fixture();
    const groundController = new FakeDevice(groundControllerIeee, "Router", 8, 0x5678);
    const groundThermostat = new FakeDevice(groundThermostatIeees[0], "EndDevice", 9, 0x3456);
    ground.registerClusters(groundController); ground.registerClusters(groundThermostat);
    return {...upstairs, groundController, groundThermostat};
}
function msg(device, command, payload, parsed = false) {
    const names = {0x10: "SyncRequest", 0x16: "WiringCentreRequest", 0x31: "Record", 0x33: "Echo", 0x37: "SyncAck"};
    return {device, endpoint: device.endpoint,
        type: parsed ? `command${names[command]}` : "raw",
        data: parsed ? {payload} : Buffer.concat([Buffer.from([0x1d, 0x78, 0x10, 0x44, command]), payload])};
}
const greeting = (number = 0xff) => Buffer.from([number, 0, 0, 0, 0, 0, 0]);
function legacyRecord(prefix = "242d4a4a") {
    const payload = Buffer.alloc(77, 0x20);
    Buffer.from(prefix, "hex").copy(payload);
    return payload;
}
const record = legacyRecord();
function zoneTable() {
    const payload = Buffer.alloc(59);
    payload[0] = 0x8a; Buffer.from("B70").copy(payload, 1); payload[9] = 8;
    for (let index = 0; index < 12; index++) payload.writeUInt16BE(0xffff, 10 + index * 3);
    payload[46] = 0xff; payload[47] = 0xdb;
    Buffer.from("7eaaaaa8800000000078", "hex").copy(payload, 49);
    return payload;
}
function deferred() {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
async function until(predicate) {for (let i = 0; i < 30 && !predicate(); i++) await Promise.resolve(); assert.ok(predicate(), "Expected asynchronous state transition");}
beforeEach(() => {clearProbeState(); ground.clearProbeState(); FakeDevice.registry = new Map();});

test("default support expands to two isolated installations without broad manufacturer matching", () => {
    assert.equal(definitions.length, 4);
    assert.deepEqual(THERMOSTAT_IEEES, [THERMOSTAT_IEEE, "0x0200000000000012", "0x0200000000000013"]);
    assert.equal(Object.isFrozen(THERMOSTAT_IEEES), true);
    for (const [definition, ieees] of [[thermostatDefinition, THERMOSTAT_IEEES], [controllerDefinition, [CONTROLLER_IEEE]],
        [definitions[2], groundThermostatIeees], [definitions[3], [groundControllerIeee]]]) {
        assert.equal(definition.zigbeeModel, undefined);
        assert.equal(definition.ota, undefined);
        for (const fp of definition.fingerprint) {
            assert.ok(ieees.some((ieee) => fp.ieeeAddr.test(ieee)));
            assert.ok(!fp.ieeeAddr.test("0x0200000000000099"));
            for (const ieee of ieees) assert.ok(!fp.ieeeAddr.test(`${ieee}00`));
        }
        for (const ieee of ieees) assert.ok(definition.fingerprint.some((fp) => fp.ieeeAddr.test(ieee)));
        const otherFloor = ieees.includes(CONTROLLER_IEEE) || ieees.includes(THERMOSTAT_IEEE)
            ? [groundControllerIeee, ...groundThermostatIeees] : [CONTROLLER_IEEE, ...THERMOSTAT_IEEES];
        for (const ieee of otherFloor) assert.ok(definition.fingerprint.every((fp) => !fp.ieeeAddr.test(ieee)));
    }
    assert.equal(isThermostat({ieeeAddr: "0x0200000000000099"}), false);
    assert.deepEqual(thermostatDefinition.toZigbee.map((item) => item.key), [["heating_setpoint"]]);
    assert.deepEqual(controllerDefinition.toZigbee.map((item) => item.key), [["zone_table", ...Array.from({length: 8}, (_, index) => `zone_${index + 1}_heating`)]]);
    assert.equal(controllerDefinition.toZigbee[0].convertSet, undefined);
});

test("each inventoried thermostat keeps device index 32, real WC lookup, independent handles and its own zone proof", async () => {
    const {controller, thermostat: first} = fixture(); accepted(controller);
    const thermostats = [first, ...THERMOSTAT_IEEES.slice(1).map((ieee, index) => new FakeDevice(ieee, "EndDevice", 9, 0x2345 + index))];
    const setpoint = thermostatDefinition.toZigbee[0];
    for (const thermostat of thermostats) {
        assert.equal(isThermostat(thermostat), true);
        await handleMessage(msg(thermostat, 0x10, greeting()), now);
        assert.equal(thermostat.tx.at(-1).payload[0], 0x20);
        await handleMessage(msg(thermostat, 0x16, Buffer.from([1])), now);
        assert.equal(thermostat.tx.at(-1).payload.toString("hex"), "016745");
        assert.equal(controllerDiagnostics(thermostat).physical_zone_pairing_verified, false);
        const state = {heating_setpoint: 21};
        assert.equal(await setpoint.convertSet(thermostat.endpoint, "heating_setpoint", 21.5, {device: thermostat, state}), undefined);
        assert.equal(thermostat.tx.at(-1).payload.toString("hex"), "014233344b");
        assert.equal(state.heating_setpoint, 21);
    }
    await setpoint.convertSet(first.endpoint, "heating_setpoint", 21, {device: first});
    assert.equal(first.tx.at(-1).payload.toString("hex"), "024233344a");
    const payload = zoneTable();
    // Proof for one room must not leak to the other approved rooms.
    payload.writeUInt16BE(thermostats[1].networkAddress, 13);
    await handleMessage(msg(controller, 0x33, payload), now);
    assert.equal(controllerDiagnostics(first).physical_zone_pairing_verified, false);
    assert.equal(controllerDiagnostics(thermostats[1]).physical_paired_zones, "2");
    assert.equal(controllerDiagnostics(thermostats[2]).physical_zone_pairing_verified, false);
    thermostats.forEach((thermostat, index) => payload.writeUInt16BE(thermostat.networkAddress, 10 + index * 3));
    await handleMessage(msg(controller, 0x33, payload), now);
    thermostats.forEach((thermostat, index) => assert.equal(controllerDiagnostics(thermostat).physical_paired_zones, String(index + 1)));
    const foreign = new FakeDevice("0x0200000000000099", "EndDevice", 9, 0x4444);
    for (const [command, data] of [[0x10, greeting()], [0x16, Buffer.from([1])]]) await handleMessage(msg(foreign, command, data), now);
    await assert.rejects(setpoint.convertSet(foreign.endpoint, "heating_setpoint", 21, {device: foreign}), /selected thermostat/);
    assert.equal(foreign.tx.length, 0); assert.equal(foreign.registrations.length, 0);
    assert.equal(controller.tx.length, 0);
});

test("controller signature requires exact IEEE, router, vendor, endpoint, profile, FC00 and current address", () => {
    const {controller} = fixture();
    assert.equal(validateControllerSignature(controller), true);
    for (const [key, value] of [["ieeeAddr", "0x02000000000000a1"], ["type", "EndDevice"], ["manufacturerName", "Other"],
        ["manufacturerID", 0], ["networkAddress", 0], ["networkAddress", 0xffff]]) {
        const original = controller[key]; controller[key] = value;
        assert.equal(validateControllerSignature(controller), false, key); controller[key] = original;
    }
    for (const [key, value] of [["ID", 9], ["profileID", 0], ["deviceIeeeAddress", THERMOSTAT_IEEE],
        ["deviceNetworkAddress", 0x9999], ["inputClusters", [0]]]) {
        const original = controller.endpoint[key]; controller.endpoint[key] = value;
        assert.equal(validateControllerSignature(controller), false, key); controller.endpoint[key] = original;
    }
});

test("registration is device-local and unknown addresses receive no registration or radio response", async () => {
    const unknown = new FakeDevice("0x0200000000000099", "Router", 8, 0x9988);
    registerClusters(unknown);
    assert.equal(unknown.registrations.length, 0);
    for (const command of [0x10, 0x16, 0x18, 0x14, 0x37]) await handleMessage(msg(unknown, command, greeting()), now);
    await handleLifecycle({type: "deviceAnnounce", data: {device: unknown}}, now);
    assert.equal(unknown.tx.length, 0); assert.equal(unknown.saves.length, 0);
});

test("controller greeting assigns slot 1 while the thermostat retains slot 0x20", async () => {
    const {controller, thermostat} = fixture();
    const state = await handleMessage(msg(controller, 0x10, greeting(1)), now);
    await handleMessage(msg(thermostat, 0x10, greeting()), now);
    assert.equal(controller.tx[0].payload[0], 1);
    assert.equal(thermostat.tx[0].payload[0], 0x20);
    assert.equal(controller.tx[0].command, "syncResponse");
    assert.equal(controller.tx[0].options.srcEndpoint, 1);
    assert.equal(controller.tx[0].bytes[0], 0x1d);
    assert.equal(state.physical_controller_slot_verified, true);
    assert.equal(state.physical_zone_pairing_verified, false);
    assert.ok(controller.saves.length > 0);
    assert.equal(JSON.stringify(controller.meta[META_KEY]).includes("networkAddress"), false);
    assert.equal(syncPayload(now, 1)[0], 1);
    assert.throws(() => syncPayload(now, 2), /Unsupported/);
});

test("presence and successful sync TX alone do not authorize positive WC lookup", async () => {
    const {controller, thermostat} = fixture();
    await handleMessage(msg(controller, 0x10, greeting()), now);
    assert.equal(controllerDiagnostics(thermostat).physical_controller_present, true);
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, false);
    await handleMessage(msg(thermostat, 0x16, Buffer.from([1])), now);
    assert.equal(thermostat.tx[0].payload.toString("hex"), "00ffff");
});

test("valid controller ACK proves offered slot 1 and lookup resolves the real current NWK", async () => {
    const {controller, thermostat} = fixture();
    await handleMessage(msg(controller, 0x10, greeting()), now);
    const state = await handleMessage(msg(controller, 0x37, Buffer.from("110000", "hex"), true), new Date(now.getTime() + 10));
    assert.equal(state.physical_controller_slot_verified, true);
    await handleMessage(msg(thermostat, 0x16, Buffer.from([1]), true), now);
    assert.equal(thermostat.tx[0].payload.toString("hex"), "016745");
    controller.networkAddress = 0x6789; controller.endpoint.deviceNetworkAddress = 0x6789;
    await handleMessage(msg(thermostat, 0x16, Buffer.from([1])), new Date(now.getTime() + 1000));
    assert.equal(thermostat.tx[1].payload.toString("hex"), "018967");
    assert.equal(JSON.stringify(controller.meta[META_KEY]).includes("6789"), false);
});

test("missing or invalid physical controller and other WC numbers never fall back to coordinator address", async () => {
    const {controller, thermostat} = fixture(); accepted(controller);
    for (const number of [2, 9]) {
        clearProbeState(); await handleMessage(msg(thermostat, 0x16, Buffer.from([number])), now);
        assert.equal(thermostat.tx.at(-1).payload.toString("hex"), "00ffff");
    }
    FakeDevice.registry.delete(CONTROLLER_IEEE);
    clearProbeState(); await handleMessage(msg(thermostat, 0x16, Buffer.from([1])), now);
    assert.equal(thermostat.tx.at(-1).payload.toString("hex"), "00ffff");
    FakeDevice.registry.set(CONTROLLER_IEEE, controller); controller.type = "EndDevice";
    clearProbeState(); await handleMessage(msg(thermostat, 0x16, Buffer.from([1])), now);
    assert.equal(thermostat.tx.at(-1).payload.toString("hex"), "00ffff");
});

test("malformed or unknown-number requests are logged without responses", async () => {
    const {controller, thermostat} = fixture();
    for (const payload of [Buffer.alloc(0), Buffer.from([0]), Buffer.from([10]), Buffer.from([255]), Buffer.from([1, 0])]) await handleMessage(msg(thermostat, 0x16, payload), now);
    for (const payload of [Buffer.alloc(0), Buffer.alloc(6), Buffer.alloc(8)]) await handleMessage(msg(controller, 0x10, payload), now);
    for (const payload of [Buffer.alloc(0), Buffer.from("1100", "hex"), Buffer.from("110001", "hex")]) await handleMessage(msg(controller, 0x37, payload), now);
    assert.equal(controller.tx.length, 0); assert.equal(thermostat.tx.length, 0);
    assert.equal(controller.saves.length, 0);
});

test("an unsolicited ACK without a matching offer cannot authorize controller number 1", async () => {
    const {controller, thermostat} = fixture();
    await handleMessage(msg(controller, 0x37, Buffer.from("110000", "hex")), now);
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, false);
});

test("a fresh unassigned or other-number greeting invalidates old accepted state", async () => {
    for (const number of [0xff, 2, 0x20]) {
        clearProbeState(); const {controller, thermostat} = fixture(); accepted(controller);
        await handleMessage(msg(controller, 0x10, greeting(number)), now);
        assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, false);
        assert.equal(controller.meta[META_KEY].accepted, false);
        assert.equal(controller.tx[0].payload[0], 1);
    }
});

test("valid ACK arriving while sync send is pending waits for its successful completion", async () => {
    const {controller} = fixture(); const transport = deferred(); controller.onSend = () => transport.promise;
    const request = handleMessage(msg(controller, 0x10, greeting()), now);
    await until(() => controller.tx.length === 1);
    const ack = handleMessage(msg(controller, 0x37, Buffer.from("110000", "hex")), new Date(now.getTime() + 10));
    await Promise.resolve(); assert.equal(controller.meta[META_KEY].accepted, false);
    transport.resolve(); await Promise.all([request, ack]);
    assert.equal(controller.meta[META_KEY].accepted, true);
});

test("failed sync send cannot authorize a concurrent ACK", async () => {
    const {controller} = fixture(); const transport = deferred(); controller.onSend = () => transport.promise;
    const request = handleMessage(msg(controller, 0x10, greeting()), now);
    await until(() => controller.tx.length === 1);
    const ack = handleMessage(msg(controller, 0x37, Buffer.from("110000", "hex")), new Date(now.getTime() + 10));
    transport.reject(new Error("adapter failure")); await Promise.all([request, ack]);
    assert.equal(controller.meta[META_KEY].accepted, false);
});

test("actual stop invalidates an in-flight sync offer and cannot persist later ACK acceptance", async () => {
    for (const type of ["stop"]) {
        clearProbeState(); const {controller} = fixture(); const transport = deferred(); controller.onSend = () => transport.promise;
        const request = handleMessage(msg(controller, 0x10, greeting()), now);
        await until(() => controller.tx.length === 1);
        const ack = handleMessage(msg(controller, 0x37, Buffer.from("110000", "hex")), new Date(now.getTime() + 10));
        await handleLifecycle({type, data: {device: controller, ieeeAddr: CONTROLLER_IEEE}}, now);
        transport.resolve(); await Promise.all([request, ack]);
        assert.equal(controller.meta[META_KEY].accepted, false);
    }
});

test("verified number survives normal stop/start, while actual SDK removal erases acceptance", async () => {
    const {controller, thermostat} = fixture();
    await handleMessage(msg(controller, 0x10, greeting(1)), now);
    const originalMeta = JSON.parse(JSON.stringify(controller.meta));
    await handleLifecycle({type: "stop", data: {ieeeAddr: CONTROLLER_IEEE}}, now);
    assert.equal(controllerDiagnostics(thermostat).physical_controller_present, true);
    assert.equal(controllerDiagnostics(thermostat).physical_controller_state, "stopped");
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, false);
    assert.equal(controllerDiagnostics(thermostat).physical_zone_pairing_verified, false);
    assert.equal(findPhysicalController(thermostat), undefined);
    controller.meta = originalMeta;
    const txCount = controller.tx.length;
    await handleLifecycle({type: "start", data: {device: controller}}, now);
    assert.equal(controller.tx.length, txCount);
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, true);
    // Actual SDK removal clears meta and excludes the object from byIeeeAddr
    // before Z2M emits stop; it does not emit a converter deviceLeave event.
    controller.meta = {}; controller.isDeleted = true;
    FakeDevice.registry.delete(CONTROLLER_IEEE);
    await handleLifecycle({type: "stop", data: {ieeeAddr: CONTROLLER_IEEE}}, now);
    assert.equal(controller.meta[META_KEY], undefined);
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, false);
});

test("only successful controller interview or announce may initiate a bounded lifecycle offer", async () => {
    const {controller, thermostat} = fixture();
    await controllerDefinition.configure(controller);
    for (const event of [{type: "start", data: {device: controller}}, {type: "deviceInterview", data: {device: controller, status: "failed"}},
        {type: "deviceInterview", data: {device: controller, status: "started"}}, {type: "deviceAnnounce", data: {device: thermostat}}]) await handleLifecycle(event, now);
    assert.equal(controller.tx.length, 0); assert.equal(thermostat.tx.length, 0);
    await handleLifecycle({type: "deviceInterview", data: {device: controller, status: "successful"}}, now);
    await handleLifecycle({type: "deviceAnnounce", data: {device: controller}}, new Date(now.getTime() + 999));
    assert.equal(controller.tx.length, 1);
    assert.equal(controller.meta[META_KEY].accepted, undefined);
    assert.equal(controller.tx[0].payload[0], 1);
});

test("announce then a fresh greeting gets one deferred fresh offer without accepting the old ACK", async () => {
    const {controller} = fixture(); const oldTransport = deferred();
    controller.onSend = () => controller.tx.length === 1 ? oldTransport.promise : undefined;
    const announce = handleLifecycle({type: "deviceAnnounce", data: {device: controller}}, now);
    await until(() => controller.tx.length === 1);
    const fresh = handleMessage(msg(controller, 0x10, greeting()), new Date(now.getTime() + 990));
    await until(() => controller.meta[META_KEY]?.requested_number === 0xff);
    await handleMessage(msg(controller, 0x37, Buffer.from("110000", "hex")), new Date(now.getTime() + 995));
    oldTransport.resolve(); await announce; await fresh;
    assert.equal(controller.tx.length, 2);
    assert.equal(controller.meta[META_KEY].accepted, false);
    await handleMessage(msg(controller, 0x37, Buffer.from("110000", "hex")), new Date(now.getTime() + 1010));
    assert.equal(controller.meta[META_KEY].accepted, true);
});

test("stop before the bounded deferred reply cancels it", async () => {
    const {controller} = fixture();
    await handleLifecycle({type: "deviceAnnounce", data: {device: controller}}, now);
    const fresh = handleMessage(msg(controller, 0x10, greeting()), new Date(now.getTime() + 990));
    await until(() => controller.meta[META_KEY]?.requested_number === 0xff);
    await handleLifecycle({type: "stop", data: {ieeeAddr: CONTROLLER_IEEE}}, now);
    await fresh;
    assert.equal(controller.tx.length, 1);
    assert.equal(controller.meta[META_KEY].accepted, false);
});

test("legacy decoding preserves published temperature field names without legacy probe markers", async () => {
    const {thermostat} = fixture();
    assert.deepEqual(decodeLegacyStatus(record), {local_temperature: 21, reported_heating_setpoint: 21, heating_setpoint: 21});
    const state = await handleMessage(msg(thermostat, 0x31, record, true), now);
    assert.equal(state.heating_setpoint, 21); assert.equal(state.local_temperature, 21);
    assert.equal(Object.hasOwn(state, "virtual_wiring_centre"), false);
    assert.equal(Object.hasOwn(state, "virtual_wiring_centre_stage"), false);
    assert.equal(thermostat.tx.length, 0);
    for (const byte of [0x7b, 0x7d]) {const copy = Buffer.from(record); copy[2] = byte; assert.equal(decodeLegacyStatus(copy).local_temperature, null);}
    for (const byte of [0, 0x60, 0x71]) {const copy = Buffer.from(record); copy[0] = byte; assert.equal(decodeLegacyStatus(copy), undefined);}
});

test("synthetic subtype3 records decode only their live temperature prefix", async () => {
    // Primary gateway parser: libit600transfer 0xef4..0xf30 classifies D/E/other
    // then converges on byte2 at 0xf34 and byte3 at 0xf88/0xfc0, same codec.
    // Synthetic subtype3 records cover different temperatures and half-degree steps.
    const captures = [
        ["0x0200000000000012", "24234d4f", 22.5, 23.5],
        ["0x0200000000000012", "24334d51", 22.5, 24.5],
        ["0x0200000000000013", "24234a42", 21, 17],
        ["0x0200000000000013", "24234b42", 21.5, 17],
        ["0x0200000000000013", "24234a42", 21, 17],
        ["0x0200000000000013", "24234a43", 21, 17.5],
    ];
    for (const [ieee, prefix, local, target] of captures) {
        const device = new FakeDevice(ieee, "EndDevice", 9, 0x2345);
        const payload = legacyRecord(prefix);
        assert.equal(payload.length, 77);
        assert.deepEqual(decodeLegacyStatus(payload), {local_temperature: local, reported_heating_setpoint: target, heating_setpoint: target});
        const state = await handleMessage(msg(device, 0x31, payload), now);
        assert.equal(state.local_temperature, local); assert.equal(state.heating_setpoint, target);
        assert.equal(state.reported_heating_setpoint, target);
        assert.equal(device.tx.length, 0);
        // Echoes and foreign endpoints must not become temperature reports.
        assert.equal((await handleMessage(msg(device, 0x33, payload), now)).local_temperature, undefined);
        assert.equal(await handleMessage({...msg(device, 0x31, payload), endpoint: {...device.endpoint, ID: 8}}, now), undefined);
    }
});

test("supported legacy prefixes preserve unknown subtype, newer tag, length and sentinel boundaries", () => {
    const payload = Buffer.from(record); payload[1] = 0x23;
    for (const subtype of [0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15]) {
        const copy = Buffer.from(payload); copy[1] = 0x20 | subtype;
        assert.equal(decodeLegacyStatus(copy), undefined);
    }
    for (const tag of [0, 0x60, 0x71, 0x72, 0x80, 0xf1, 0xf2]) {
        const copy = Buffer.from(payload); copy[0] = tag;
        assert.equal(decodeLegacyStatus(copy), undefined);
    }
    for (const malformed of [payload.subarray(0, 76), Buffer.concat([payload, Buffer.from([0])]), {length: 77}]) assert.equal(decodeLegacyStatus(malformed), undefined);
    for (const sentinel of [0x7b, 0x7d]) {
        const copy = Buffer.from(payload); copy[2] = sentinel;
        assert.equal(decodeLegacyStatus(copy).local_temperature, null);
    }
});

test("synthetic subtype1 records decode temperature and setpoint changes", async () => {
    // Synthetic subtype1 prefixes use independent temperatures and targets.
    const captures = [
        ["25214a4a", 21, 21],
        ["25214c4a", 22, 21],
        ["25214d4a", 22.5, 21],
        ["25214d46", 22.5, 19],
        ["25214c46", 22, 19],
    ];
    const device = new FakeDevice("0x0200000000000021", "EndDevice", 9, 0x3456);
    for (const [prefix, local, target] of captures) {
        const payload = legacyRecord(prefix);
        assert.equal(payload.length, 77);
        assert.deepEqual(decodeLegacyStatus(payload), {
            local_temperature: local, reported_heating_setpoint: target, heating_setpoint: target,
        });
        const state = await ground.handleMessage(msg(device, 0x31, payload, true), now);
        assert.equal(state.local_temperature, local);
        assert.equal(state.reported_heating_setpoint, target);
        assert.equal(state.heating_setpoint, target);
        for (const key of ["schedule", "preset", "running_state", "system_mode"]) assert.equal(Object.hasOwn(state, key), false);
        assert.equal(device.tx.length, 0);
        // The same bytes in an echo or on another endpoint are not a report.
        assert.equal((await ground.handleMessage(msg(device, 0x33, payload), now)).local_temperature, undefined);
        assert.equal(await ground.handleMessage({...msg(device, 0x31, payload), endpoint: {...device.endpoint, ID: 8}}, now), undefined);
    }
});

test("subtype1 decoding keeps length, legacy tag, unknown subtype2 and temperature sentinel guards", () => {
    const payload = legacyRecord("25214c46");
    for (const malformed of [payload.subarray(0, 76), Buffer.concat([payload, Buffer.from([0])]), {length: 77}]) {
        assert.equal(decodeLegacyStatus(malformed), undefined);
    }
    for (const tag of [0, 0x60, 0x71, 0x72, 0x80, 0xf1, 0xf2]) {
        const copy = Buffer.from(payload); copy[0] = tag;
        assert.equal(decodeLegacyStatus(copy), undefined);
    }
    for (const subtypeByte of [0x02, 0x22, 0x32]) {
        const copy = Buffer.from(payload); copy[1] = subtypeByte;
        assert.equal(decodeLegacyStatus(copy), undefined);
    }
    for (const sentinel of [0x7b, 0x7d]) {
        const copy = Buffer.from(payload); copy[2] = sentinel;
        assert.deepEqual(decodeLegacyStatus(copy), {
            local_temperature: null, reported_heating_setpoint: 19, heating_setpoint: 19,
        });
    }
});

test("legacy four-byte pairing confirmation and all zone/heat reports are never synthesized or acknowledged", async () => {
    const {controller, thermostat} = fixture(); accepted(controller);
    for (const [command, payload] of [[0x14, "01012a00"], [0x18, "01010101ff0000"], [0x12, "02010101ffff0000000000ffffffffffffff"], [0x83, "0101ff00000000"]]) {
        await handleMessage(msg(thermostat, command, Buffer.from(payload, "hex")), now);
        await handleMessage(msg(controller, command, Buffer.from(payload, "hex")), now);
    }
    assert.equal(controller.tx.length, 0); assert.equal(thermostat.tx.length, 0);
});

test("B70 parsing accepts only the known full layout and keeps flags as raw diagnostics", async () => {
    const {controller, thermostat} = fixture(); accepted(controller);
    const payload = zoneTable(); payload.writeUInt16BE(thermostat.networkAddress, 10); payload[12] = 0xa5;
    const parsed = parseZoneTable(payload);
    assert.equal(parsed.slots[0].address, 0x1234); assert.equal(parsed.slots[0].flag, 0xa5);
    assert.equal(parsed.lqi, 255); assert.equal(parsed.rssi, -37);
    const state = await handleMessage(msg(controller, 0x33, payload, true), now);
    assert.equal(state.zone_1, "0x1234"); assert.equal(state.zone_1_flag, 0xa5);
    assert.equal(state.physical_zone_pairing_verified, true); assert.equal(state.physical_paired_zones, "1");
    assert.equal(state.zone_2, null);
    assert.deepEqual(JSON.parse(state.zone_table), ["0x1234", null, null, null, null, null, null, null]);
    assert.equal(controller.tx.length, 0);
});

test("zone-table state fits the HA limit even with eight occupied zones", async () => {
    const {controller} = fixture(); accepted(controller); const payload = zoneTable();
    for (let i = 0; i < 8; i++) payload.writeUInt16BE(0x1000 + i, 10 + 3 * i);
    const state = await handleMessage(msg(controller, 0x33, payload), now);
    assert.ok(state.zone_table.length <= 255);
    assert.equal(JSON.parse(state.zone_table).length, 8);
});

test("synthetic B70 accepts the known zero-filled trailer and retains raw flags", async () => {
    const {controller} = fixture(); accepted(controller);
    const payload = zoneTable();
    for (let index = 0; index < 12; index++) payload[12 + index * 3] = 0xf0;
    payload[47] = 0xc0;
    payload.fill(0, 49, 58);
    payload[58] = 0x78;
    assert.equal(payload.length, 59);
    const parsed = parseZoneTable(payload);
    assert.deepEqual(parsed.slots, Array.from({length: 12}, () => ({address: null, flag: 0xf0})));
    assert.equal(parsed.lqi, 255); assert.equal(parsed.rssi, -64);
    const state = await handleMessage(msg(controller, 0x33, payload), now);
    assert.equal(state.zone_table_valid, true);
    assert.deepEqual(JSON.parse(state.zone_table), Array(8).fill(null));
    assert.equal(state.zone_1_flag, 0xf0); assert.equal(state.zone_8_flag, 0xf0);
    assert.equal(state.physical_zone_pairing_verified, false);
    assert.equal(controller.tx.length, 0);
    for (let offset = 49; offset < 59; offset++) {
        const malformed = Buffer.from(payload); malformed[offset] ^= 1;
        assert.equal(parseZoneTable(malformed), undefined, `Malformed legacy trailer at byte ${offset}`);
    }
    for (const [offset, value] of [[1, 0], [4, 1], [9, 12], [48, 1]]) {
        const malformed = Buffer.from(payload); malformed[offset] = value;
        assert.equal(parseZoneTable(malformed), undefined);
    }
    const reserved = Buffer.from(payload); reserved.writeUInt16BE(0xfffe, 10);
    assert.equal(parseZoneTable(reserved), undefined);
    assert.equal(parseZoneTable(payload.subarray(0, 58)), undefined);
});

test("short, unknown and malformed B70 layouts cannot assert pairing proof", async () => {
    const {controller, thermostat} = fixture(); accepted(controller);
    const valid = zoneTable(); valid.writeUInt16BE(thermostat.networkAddress, 10);
    const invalid = [valid.subarray(0, 34), Buffer.concat([valid, Buffer.from([0])])];
    for (const [offset, value] of [[1, 0], [4, 1], [9, 12], [48, 1], [49, 0]]) {const copy = Buffer.from(valid); copy[offset] = value; invalid.push(copy);}
    const reserved = Buffer.from(valid); reserved.writeUInt16BE(0xfffe, 10); invalid.push(reserved);
    for (const payload of invalid) assert.equal(parseZoneTable(payload), undefined);
    await handleMessage(msg(controller, 0x33, valid), now);
    const malformed = Buffer.from(valid); malformed[9] = 12;
    const state = await handleMessage(msg(controller, 0x33, malformed), now);
    assert.equal(state.zone_table_valid, false);
    assert.equal(state.physical_zone_pairing_verified, false);
});

test("zone evidence is separate from controller readiness and is invalid after address changes", async () => {
    const {controller, thermostat} = fixture(); const payload = zoneTable(); payload.writeUInt16BE(thermostat.networkAddress, 10);
    await handleMessage(msg(controller, 0x33, payload), now);
    assert.equal(controllerDiagnostics(thermostat).physical_zone_pairing_verified, false);
    accepted(controller); assert.equal(controllerDiagnostics(thermostat).physical_zone_pairing_verified, true);
    controller.networkAddress = 0x5678; controller.endpoint.deviceNetworkAddress = 0x5678;
    assert.equal(controllerDiagnostics(thermostat).physical_zone_pairing_verified, false);
});

test("B70 GET sends the exact native read-only query once, registers before SDK lookup, and is bounded", async () => {
    const {controller} = fixture(); controller.customClusters = {}; controller.registrations = [];
    const query = controllerDefinition.toZigbee[0];
    await query.convertGet(controller.endpoint, "zone_table", {device: controller});
    assert.equal(controller.tx.length, 1);
    assert.equal(controller.tx[0].payload.toString("hex"), "014237307eaaaaa88000000078");
    assert.deepEqual(controller.registrations, [CLUSTER, "genBasic"]);
    assert.equal(controller.tx[0].options.srcEndpoint, 1);
    assert.equal(controller.tx[0].bytes.toString("hex"), "1d78104432014237307eaaaaa88000000078");
    await assert.rejects(query.convertGet(controller.endpoint, "zone_table", {device: controller}), /five seconds/);
    assert.equal(controller.tx.length, 1);
});

test("B70 GET rejects wrong hardware, endpoint, key and an absent registry entry", async () => {
    const {controller, thermostat} = fixture(); const query = controllerDefinition.toZigbee[0];
    for (const [entity, key, device] of [[thermostat.endpoint, "zone_table", thermostat], [{...controller.endpoint}, "zone_table", controller],
        [controller.endpoint, "raw_write", controller]]) await assert.rejects(query.convertGet(entity, key, {device}), /exact validated physical/);
    FakeDevice.registry.delete(CONTROLLER_IEEE);
    await assert.rejects(query.convertGet(controller.endpoint, "zone_table", {device: controller}), /exact validated physical/);
    assert.equal(controller.tx.length, 0);
});

test("heating control fails closed without real validated and accepted WC1", async () => {
    const {controller, thermostat} = fixture(); const setpoint = thermostatDefinition.toZigbee[0];
    const write = () => setpoint.convertSet(thermostat.endpoint, "heating_setpoint", 23, {device: thermostat, state: {}});
    await assert.rejects(write(), /Physical WC1/);
    accepted(controller); controller.manufacturerName = "Wrong"; await assert.rejects(write(), /Physical WC1/);
    controller.manufacturerName = "Computime"; FakeDevice.registry.delete(CONTROLLER_IEEE); await assert.rejects(write(), /Physical WC1/);
    assert.equal(thermostat.tx.length, 0);
});

test("B34 preserves finite half-degree target control and publishes no optimistic state", async () => {
    const {controller, thermostat} = fixture(); accepted(controller); const setpoint = thermostatDefinition.toZigbee[0];
    const state = {heating_setpoint: 21, reported_heating_setpoint: 21};
    for (const [value, suffix] of [[5, "2a"], [21, "4a"], [21.5, "4b"], [23, "4e"], [35, "66"]]) {
        thermostat.customClusters = {};
        assert.equal(await setpoint.convertSet(thermostat.endpoint, "heating_setpoint", value, {device: thermostat, state}), undefined);
        assert.equal(thermostat.tx.at(-1).payload.subarray(1).toString("hex"), `423334${suffix}`);
        assert.equal(thermostat.tx.at(-1).options.srcEndpoint, 1);
        assert.equal(state.heating_setpoint, 21); assert.equal(state.reported_heating_setpoint, 21);
    }
    assert.equal(thermostat.tx.length, 5); assert.equal(controller.tx.length, 0);
});

test("invalid target values, wrong thermostat/endpoint and failed sends cannot bypass guards or retry", async () => {
    const {controller, thermostat} = fixture(); accepted(controller); const setpoint = thermostatDefinition.toZigbee[0];
    for (const value of [4.5, 35.5, 22.25, NaN, Infinity, "21", null]) await assert.rejects(setpoint.convertSet(thermostat.endpoint, "heating_setpoint", value, {device: thermostat}), /0.5/);
    const other = new FakeDevice("0x0200000000000099", "EndDevice", 9, 0x4444);
    await assert.rejects(setpoint.convertSet(other.endpoint, "heating_setpoint", 23, {device: other}), /selected thermostat/);
    await assert.rejects(setpoint.convertSet(controller.endpoint, "heating_setpoint", 23, {device: thermostat}), /selected thermostat/);
    thermostat.onSend = async () => {throw new Error("adapter refused");};
    await assert.rejects(setpoint.convertSet(thermostat.endpoint, "heating_setpoint", 23, {device: thermostat}), /adapter refused/);
    assert.equal(thermostat.tx.length, 1);
});

test("all outgoing controller frames are only sync response or native B70 query, with no simulation commands", async () => {
    const {controller, thermostat} = fixture();
    await handleLifecycle({type: "deviceAnnounce", data: {device: controller}}, now);
    await handleMessage(msg(controller, 0x37, Buffer.from("110000", "hex")), new Date(now.getTime() + 5));
    await controllerDefinition.toZigbee[0].convertGet(controller.endpoint, "zone_table", {device: controller});
    await handleMessage(msg(thermostat, 0x16, Buffer.from([1])), now);
    for (const sent of controller.tx) {
        assert.ok(["syncResponse", "write"].includes(sent.command));
        if (sent.command === "write") assert.equal(sent.payload.subarray(1, 4).toString("latin1"), "B70");
        assert.equal(sent.bytes[0], 0x1d);
        assert.equal(sent.options.srcEndpoint, 1);
    }
    for (const device of [controller, thermostat]) assert.ok(device.tx.every((sent) => ![0x12, 0x14, 0x18, 0x84, 0x88].includes(sent.bytes[4])));
});

test("the real SDK endpoint path re-registers stale commands before B34 without accessing an adapter", async () => {
    const require = createRequire(import.meta.url); const sdkRoot = path.dirname(require.resolve("zigbee-herdsman"));
    const Endpoint = require(path.join(sdkRoot, "controller/model/endpoint.js")).default;
    const Device = require(path.join(sdkRoot, "controller/model/device.js")).default;
    const {controller} = fixture(); accepted(controller);
    const device = Object.create(Device.prototype);
    device.ieeeAddr = THERMOSTAT_IEEE; device._customClusters = {}; device.meta = {};
    Object.defineProperty(device, "constructor", {value: FakeDevice});
    Object.defineProperty(device, "manufacturerID", {value: 0x1078});
    FakeDevice.registry.set(THERMOSTAT_IEEE, device);
    registerClusters(device);
    const original = device.customClusters[CLUSTER];
    device._customClusters[CLUSTER] = {...original, commands: {...original.commands}, commandsResponse: {...original.commandsResponse}};
    delete device.customClusters[CLUSTER].commands.write; delete device.customClusters[CLUSTER].commandsResponse.write;
    const endpoint = Object.create(Endpoint.prototype);
    endpoint.ID = 9; endpoint.deviceIeeeAddress = THERMOSTAT_IEEE; endpoint.deviceNetworkAddress = 0x1234; endpoint.getDevice = () => device;
    const sent = []; endpoint.sendRequest = async (frame, options) => {sent.push({bytes: frame.toBuffer(), options});};
    await thermostatDefinition.toZigbee[0].convertSet(endpoint, "heating_setpoint", 21.5, {device});
    assert.equal(sent.length, 1);
    assert.equal(sent[0].bytes.subarray(4).toString("hex"), "32014233344b");
    assert.equal(sent[0].bytes[0], 0x1d); assert.equal(sent[0].options.srcEndpoint, 1);
});


test("a removed controller cannot be restored by stale traffic and a new join needs fresh slot proof", async () => {
    const {controller, thermostat} = fixture(); accepted(controller);
    controller.isDeleted = true; controller.meta = {}; FakeDevice.registry.delete(CONTROLLER_IEEE);
    await handleLifecycle({type: "stop", data: {ieeeAddr: CONTROLLER_IEEE}}, now);
    const previousTx = controller.tx.length;
    await handleLifecycle({type: "start", data: {device: controller}}, now);
    await handleMessage(msg(controller, 0x10, greeting(1)), now);
    assert.equal(controller.tx.length, previousTx);
    assert.equal(findPhysicalController(thermostat), undefined);
    const replacement = new FakeDevice(CONTROLLER_IEEE, "Router", 8, 0x6789);
    registerClusters(replacement);
    await handleLifecycle({type: "start", data: {device: replacement}}, now);
    assert.equal(findPhysicalController(thermostat), replacement);
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, false);
});

test("two floors keep exact controller, thermostat, and endpoint ownership separate", async () => {
    const {controller, thermostat, groundController, groundThermostat} = twoFloors();
    assert.equal(ground.validateControllerSignature(groundController), true);
    assert.equal(ground.validateControllerSignature(controller), false);
    assert.equal(validateControllerSignature(groundController), false);
    assert.equal(isThermostat(groundThermostat), false);
    assert.equal(ground.isThermostat(thermostat), false);
    for (const device of [groundController, groundThermostat]) {
        const registrations = device.registrations.length;
        registerClusters(device);
        assert.equal(device.registrations.length, registrations);
        assert.equal(await handleMessage(msg(device, 0x10, greeting()), now), undefined);
        await handleLifecycle({type: "deviceAnnounce", data: {device}}, now);
    }
    for (const device of [controller, thermostat]) {
        const registrations = device.registrations.length;
        ground.registerClusters(device);
        assert.equal(device.registrations.length, registrations);
        assert.equal(await ground.handleMessage(msg(device, 0x10, greeting()), now), undefined);
        await ground.handleLifecycle({type: "deviceAnnounce", data: {device}}, now);
    }
    assert.equal(groundController.tx.length, 0); assert.equal(controller.tx.length, 0);
    assert.equal(groundThermostat.tx.length, 0); assert.equal(thermostat.tx.length, 0);
    for (const device of [groundController, groundThermostat]) {
        const foreignEndpoint = {...device.endpoint, deviceIeeeAddress: controller.ieeeAddr};
        assert.equal(await ground.handleMessage({...msg(device, 0x10, greeting()), endpoint: foreignEndpoint}, now), undefined);
    }
});

test("WC2 sync offers number two while both floors' thermostats retain device index 32", async () => {
    const {controller, thermostat, groundController, groundThermostat} = twoFloors();
    await handleMessage(msg(controller, 0x10, greeting()), now);
    await ground.handleMessage(msg(groundController, 0x10, greeting()), now);
    await handleMessage(msg(thermostat, 0x10, greeting()), now);
    await ground.handleMessage(msg(groundThermostat, 0x10, greeting()), now);
    assert.equal(controller.tx.at(-1).payload[0], 1);
    assert.equal(groundController.tx.at(-1).payload[0], 2);
    assert.equal(thermostat.tx.at(-1).payload[0], 0x20);
    assert.equal(groundThermostat.tx.at(-1).payload[0], 0x20);
    assert.equal(ground.syncPayload(now, 2)[0], 2);
    assert.equal(ground.syncPayload(now, 0x20)[0], 0x20);
    assert.throws(() => ground.syncPayload(now, 1), /Unsupported/);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, false);
});

test("WC2 needs its own accepted number and never inherits WC1 metadata or acceptance", async () => {
    const {controller, groundController, groundThermostat} = twoFloors(); accepted(controller);
    const diagnose = () => ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified;
    assert.equal(diagnose(), false);
    accepted(groundController, 1);
    assert.equal(diagnose(), false);
    accepted(groundController, 2);
    groundController.meta[META_KEY].ieee = CONTROLLER_IEEE;
    assert.equal(diagnose(), false);
    accepted(groundController, 2);
    groundController.meta[META_KEY].accepted_by = "request_number_1";
    assert.equal(diagnose(), false);
    accepted(groundController, 2);
    assert.equal(diagnose(), true);
    const state = await ground.handleMessage(msg(groundController, 0x10, greeting(1)), now);
    assert.equal(state.physical_controller_slot_verified, false);
    assert.equal(groundController.meta[META_KEY].wc_number, 2);
    assert.equal(groundController.meta[META_KEY].accepted, false);
    assert.equal(groundController.tx.at(-1).payload[0], 2);
    await ground.handleMessage(msg(groundController, 0x10, greeting(2)), new Date(now.getTime() + 1000));
    assert.equal(diagnose(), true);
    assert.equal(groundController.meta[META_KEY].accepted_by, "request_number_2");
    assert.equal(controllerDiagnostics(controller).physical_controller_slot_verified, true);
});

test("floor-specific WC lookup resolves only the assigned controller number and address", async () => {
    const {controller, thermostat, groundController, groundThermostat} = twoFloors();
    accepted(controller); accepted(groundController, 2);
    await handleMessage(msg(thermostat, 0x16, Buffer.from([1])), now);
    await ground.handleMessage(msg(groundThermostat, 0x16, Buffer.from([2])), now);
    assert.equal(thermostat.tx.at(-1).payload.toString("hex"), "016745");
    assert.equal(groundThermostat.tx.at(-1).payload.toString("hex"), "017856");
    const later = new Date(now.getTime() + 1000);
    await handleMessage(msg(thermostat, 0x16, Buffer.from([2])), later);
    await ground.handleMessage(msg(groundThermostat, 0x16, Buffer.from([1])), later);
    assert.equal(thermostat.tx.at(-1).payload.toString("hex"), "00ffff");
    assert.equal(groundThermostat.tx.at(-1).payload.toString("hex"), "00ffff");
    groundController.networkAddress = 0x6789; groundController.endpoint.deviceNetworkAddress = 0x6789;
    await ground.handleMessage(msg(groundThermostat, 0x16, Buffer.from([2])), new Date(now.getTime() + 2000));
    assert.equal(groundThermostat.tx.at(-1).payload.toString("hex"), "018967");
    assert.equal(JSON.stringify(groundController.meta[META_KEY]).includes("6789"), false);
});

test("all three ground-floor thermostats use WC2 without expanding the upstairs allowlist", async () => {
    const {controller, groundController, groundThermostat} = twoFloors();
    accepted(controller); accepted(groundController, 2);
    const rooms = [groundThermostat, ...groundThermostatIeees.slice(1).map((ieee, index) => new FakeDevice(ieee, "EndDevice", 9, 0x3500 + index))];
    for (const room of rooms) {
        assert.equal(isThermostat(room), false); assert.equal(ground.isThermostat(room), true);
        ground.registerClusters(room);
        await ground.handleMessage(msg(room, 0x10, greeting()), now);
        assert.equal(room.tx.at(-1).payload[0], 0x20);
        await ground.handleMessage(msg(room, 0x16, Buffer.from([2])), now);
        assert.equal(room.tx.at(-1).payload.toString("hex"), "017856");
        assert.equal(await groundThermostatDefinition.toZigbee[0].convertSet(room.endpoint, "heating_setpoint", 21.5, {device: room}), undefined);
        assert.equal(room.tx.at(-1).payload.toString("hex"), "014233344b");
        await assert.rejects(thermostatDefinition.toZigbee[0].convertSet(room.endpoint, "heating_setpoint", 21.5, {device: room}), /selected thermostat/);
    }
    assert.equal(controller.tx.length, 0); assert.equal(groundController.tx.length, 0);
});

test("a ready controller on the other floor cannot enable a missing or unverified controller's setpoints", async () => {
    const {controller, thermostat, groundController, groundThermostat} = twoFloors();
    accepted(controller);
    const groundSet = () => groundThermostatDefinition.toZigbee[0].convertSet(groundThermostat.endpoint, "heating_setpoint", 19, {device: groundThermostat});
    await assert.rejects(groundSet(), /Physical WC2/);
    FakeDevice.registry.delete(groundControllerIeee);
    await assert.rejects(groundSet(), /Physical WC2/);
    FakeDevice.registry.set(groundControllerIeee, groundController); accepted(groundController, 2);
    FakeDevice.registry.delete(CONTROLLER_IEEE);
    assert.equal(await groundSet(), undefined);
    await assert.rejects(thermostatDefinition.toZigbee[0].convertSet(thermostat.endpoint, "heating_setpoint", 21, {device: thermostat}), /Physical WC1/);
    assert.equal(thermostat.tx.length, 0); assert.equal(groundThermostat.tx.length, 1);
});

test("B70 pairing proof belongs to one floor and cannot be borrowed through another controller", async () => {
    const {controller, thermostat, groundController, groundThermostat} = twoFloors();
    accepted(controller); accepted(groundController, 2);
    const upstairsTable = zoneTable(); upstairsTable.writeUInt16BE(thermostat.networkAddress, 10);
    // Even a malformed physical association to an approved other-floor room is
    // insufficient to claim proof for this installation's own thermostat.
    upstairsTable.writeUInt16BE(groundThermostat.networkAddress, 13);
    await handleMessage(msg(controller, 0x33, upstairsTable), now);
    assert.equal(controllerDiagnostics(thermostat).physical_paired_zones, "1");
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_zone_table_current, false);
    const downstairsTable = zoneTable(); downstairsTable.writeUInt16BE(groundThermostat.networkAddress, 16);
    downstairsTable.writeUInt16BE(thermostat.networkAddress, 13);
    await ground.handleMessage(msg(groundController, 0x33, downstairsTable), now);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_paired_zones, "3");
    assert.equal(ground.controllerDiagnostics(groundController).physical_paired_zones, "3");
    assert.equal(controllerDiagnostics(controller).physical_paired_zones, "1");
    const invalid = Buffer.from(downstairsTable); invalid[9] = 12;
    await ground.handleMessage(msg(groundController, 0x33, invalid), now);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_zone_pairing_verified, false);
    assert.equal(controllerDiagnostics(thermostat).physical_zone_pairing_verified, true);
});

test("controller query throttles and handles stay independent between floors", async () => {
    const {controller, groundController} = twoFloors();
    const upstairsQuery = controllerDefinition.toZigbee[0]; const downstairsQuery = groundControllerDefinition.toZigbee[0];
    await upstairsQuery.convertGet(controller.endpoint, "zone_table", {device: controller});
    await downstairsQuery.convertGet(groundController.endpoint, "zone_table", {device: groundController});
    assert.equal(controller.tx[0].payload.toString("hex"), "014237307eaaaaa88000000078");
    assert.equal(groundController.tx[0].payload.toString("hex"), "014237307eaaaaa88000000078");
    await assert.rejects(upstairsQuery.convertGet(controller.endpoint, "zone_table", {device: controller}), /five seconds/);
    await assert.rejects(downstairsQuery.convertGet(groundController.endpoint, "zone_table", {device: groundController}), /five seconds/);
    await assert.rejects(downstairsQuery.convertGet(controller.endpoint, "zone_table", {device: controller}), /exact validated physical/);
    await assert.rejects(upstairsQuery.convertGet(groundController.endpoint, "zone_table", {device: groundController}), /exact validated physical/);
});

test("stopping ground-floor discovery cannot cancel an upstairs in-flight sync offer", async () => {
    const {controller, thermostat, groundController, groundThermostat} = twoFloors();
    const transport = deferred(); controller.onSend = () => transport.promise;
    const request = handleMessage(msg(controller, 0x10, greeting()), now);
    await until(() => controller.tx.length === 1);
    await ground.handleMessage(msg(groundController, 0x10, greeting(2)), now);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, true);
    await ground.handleLifecycle({type: "stop", data: {ieeeAddr: groundControllerIeee}}, now);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_state, "stopped");
    const ack = handleMessage(msg(controller, 0x37, Buffer.from("110000", "hex")), new Date(now.getTime() + 10));
    transport.resolve(); await Promise.all([request, ack]);
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, true);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, false);
});

test("upstairs stop, removal, and reset do not clear ground-floor acceptance or zone evidence", async () => {
    const {controller, groundController, groundThermostat} = twoFloors();
    accepted(controller); accepted(groundController, 2);
    const table = zoneTable(); table.writeUInt16BE(groundThermostat.networkAddress, 10);
    await ground.handleMessage(msg(groundController, 0x33, table), now);
    await handleLifecycle({type: "stop", data: {ieeeAddr: CONTROLLER_IEEE}}, now);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, true);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_zone_pairing_verified, true);
    controller.isDeleted = true; controller.meta = {}; FakeDevice.registry.delete(CONTROLLER_IEEE);
    await handleLifecycle({type: "stop", data: {ieeeAddr: CONTROLLER_IEEE}}, now);
    clearProbeState();
    assert.equal(ground.findPhysicalController(groundThermostat), groundController);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_paired_zones, "1");
});

test("WC2 malformed or unsolicited ACKs cannot authorize a controller, and other-floor lookup stays closed", async () => {
    const {controller, thermostat, groundController, groundThermostat} = twoFloors(); accepted(controller);
    for (const payload of ["", "11", "1100", "110001", "ffffff", "110000", "120000"]) {
        await ground.handleMessage(msg(groundController, 0x37, Buffer.from(payload, "hex")), now);
    }
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, false);
    await ground.handleMessage(msg(groundThermostat, 0x16, Buffer.from([2])), now);
    assert.equal(groundThermostat.tx.at(-1).payload.toString("hex"), "00ffff");
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, true);
});

test("WC2 ACK120000 authorizes only its successfully offered number two", async () => {
    const {controller, thermostat, groundController, groundThermostat} = twoFloors();
    await ground.handleMessage(msg(groundController, 0x10, greeting()), now);
    assert.equal(groundController.tx.at(-1).payload[0], 2);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, false);
    // Actual ground-floor controller exchange: ACK0x37 payload120000 arrived
    // 174ms after a number-two offer; the user's Pair LED check confirmed WC2.
    const state = await ground.handleMessage(msg(groundController, 0x37, Buffer.from("120000", "hex"), true), new Date(now.getTime() + 174));
    assert.equal(state.controller_sync_ack_seen, true);
    assert.equal(state.physical_controller_slot_verified, true);
    assert.equal(groundController.meta[META_KEY].wc_number, 2);
    assert.equal(groundController.meta[META_KEY].ieee, groundControllerIeee);
    assert.equal(groundController.meta[META_KEY].accepted_by, "sync_ack");
    assert.equal(groundController.meta[META_KEY].reason, "verified_ack");
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, false);
    assert.equal(controller.tx.length, 0);
    await ground.handleMessage(msg(groundThermostat, 0x16, Buffer.from([2])), new Date(now.getTime() + 200));
    assert.equal(groundThermostat.tx.at(-1).payload.toString("hex"), "017856");
    const savedMeta = JSON.parse(JSON.stringify(groundController.meta));
    await ground.handleLifecycle({type: "stop", data: {ieeeAddr: groundControllerIeee}}, now);
    groundController.meta = savedMeta;
    await ground.handleLifecycle({type: "start", data: {device: groundController}}, now);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, true);
});

test("WC1 ACK and malformed or guessed ACKs cannot accept an offered WC2", async () => {
    const {groundController, groundThermostat} = twoFloors();
    await ground.handleMessage(msg(groundController, 0x10, greeting()), now);
    for (const payload of ["110000", "130000", "220000", "120001", "1200", "12000000", "ffffff"]) {
        await ground.handleMessage(msg(groundController, 0x37, Buffer.from(payload, "hex")), new Date(now.getTime() + 174));
        assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, false, payload);
        assert.equal(groundController.meta[META_KEY].accepted, false, payload);
    }
    // Rejected ACKs do not consume the valid WC2 ACK's throttle allowance.
    await ground.handleMessage(msg(groundController, 0x37, Buffer.from("120000", "hex")), new Date(now.getTime() + 174));
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, true);
});

test("an expired WC2 ACK or one dated before its offer cannot accept number two", async () => {
    for (const offset of [-1, 120001]) {
        ground.clearProbeState();
        const {groundController, groundThermostat} = twoFloors();
        await ground.handleMessage(msg(groundController, 0x10, greeting()), now);
        const state = await ground.handleMessage(msg(groundController, 0x37, Buffer.from("120000", "hex")), new Date(now.getTime() + offset));
        assert.equal(state.controller_sync_ack_seen, true);
        assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, false, String(offset));
        assert.equal(groundController.meta[META_KEY].accepted, false);
    }
});

test("failed WC2 offer cannot be accepted by its concurrently arriving valid ACK", async () => {
    const {groundController, groundThermostat} = twoFloors();
    const transport = deferred(); groundController.onSend = () => transport.promise;
    const request = ground.handleMessage(msg(groundController, 0x10, greeting()), now);
    await until(() => groundController.tx.length === 1);
    const ack = ground.handleMessage(msg(groundController, 0x37, Buffer.from("120000", "hex")), new Date(now.getTime() + 174));
    transport.reject(new Error("WC2 adapter failure"));
    await Promise.all([request, ack]);
    assert.equal(groundController.meta[META_KEY].accepted, false);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, false);
});

test("WC2 ACK cannot accept an upstairs offer or restore a stopped ground-floor offer", async () => {
    const {controller, thermostat, groundController, groundThermostat} = twoFloors();
    await handleMessage(msg(controller, 0x10, greeting()), now);
    await ground.handleMessage(msg(groundController, 0x37, Buffer.from("120000", "hex")), new Date(now.getTime() + 174));
    await handleMessage(msg(controller, 0x37, Buffer.from("120000", "hex")), new Date(now.getTime() + 174));
    assert.equal(controllerDiagnostics(thermostat).physical_controller_slot_verified, false);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, false);
    const transport = deferred(); groundController.onSend = () => transport.promise;
    const request = ground.handleMessage(msg(groundController, 0x10, greeting()), now);
    await until(() => groundController.tx.length === 1);
    const ack = ground.handleMessage(msg(groundController, 0x37, Buffer.from("120000", "hex")), new Date(now.getTime() + 174));
    await ground.handleLifecycle({type: "stop", data: {ieeeAddr: groundControllerIeee}}, now);
    transport.resolve(); await Promise.all([request, ack]);
    assert.equal(groundController.meta[META_KEY].accepted, false);
    assert.equal(ground.controllerDiagnostics(groundThermostat).physical_controller_slot_verified, false);
});

test("unverified controller numbers are rejected before any protocol state exists", () => {
    for (const wcNumber of [0, 3, 4, 9, 10, 1.5, "1"]) {
        assert.throws(() => createInstallation({
            controllerIeee: "0x0200000000000003", thermostatIeees: ["0x0200000000000031"], wcNumber, clock,
        }));
    }
});


test("zone heating follows the observed OFF/ON/OFF flags without changing raw diagnostics", async () => {
    const {controller, thermostat} = fixture(); accepted(controller);
    const payload = zoneTable(); payload.writeUInt16BE(thermostat.networkAddress, 10);
    for (const [flag, expected] of [[0xf4, false], [0xfc, true], [0xf4, false], [0x04, false], [0x0c, true]]) {
        payload[12] = flag;
        const state = await handleMessage(msg(controller, 0x33, payload), now);
        assert.equal(state.zone_1_heating, expected);
        assert.equal(state.zone_1_flag, flag);
        assert.equal(state.zone_1, "0x1234");
        assert.equal(state.zone_table_seen, now.toISOString());
        assert.equal(state.zone_2_heating, null);
    }
    assert.equal(controller.tx.length, 0, "Reading activity must not command an output");
});

test("empty slots and unknown flags never assert a heating state", async () => {
    const {controller, thermostat} = fixture(); accepted(controller);
    const payload = zoneTable();
    // Even an on-shaped flag cannot make an unassigned zone active.
    for (let index = 0; index < 8; index++) payload[12 + index * 3] = 0xfc;
    let state = await handleMessage(msg(controller, 0x33, payload), now);
    for (let index = 1; index <= 8; index++) assert.equal(state[`zone_${index}_heating`], null);
    payload.writeUInt16BE(thermostat.networkAddress, 10);
    for (const flag of [0, 0x08, 0xf0, 0xa5, 0xff]) {
        payload[12] = flag;
        state = await handleMessage(msg(controller, 0x33, payload), now);
        assert.equal(state.zone_1_heating, null, `Unknown occupied flag ${flag}`);
        assert.equal(state.zone_1_flag, flag);
    }
});

test("invalid B70 and unassigned sync clear a previously active zone snapshot", async () => {
    const {controller, thermostat} = fixture(); accepted(controller);
    const payload = zoneTable(); payload.writeUInt16BE(thermostat.networkAddress, 10); payload[12] = 0xfc;
    assert.equal((await handleMessage(msg(controller, 0x33, payload), now)).zone_1_heating, true);
    const malformed = Buffer.from(payload); malformed[9] = 12;
    let state = await handleMessage(msg(controller, 0x33, malformed), now);
    assert.equal(state.zone_table_valid, false);
    for (let index = 1; index <= 8; index++) assert.equal(state[`zone_${index}_heating`], null);
    await handleMessage(msg(controller, 0x33, payload), now);
    state = await handleMessage(msg(controller, 0x10, greeting()), now);
    for (let index = 1; index <= 8; index++) assert.equal(state[`zone_${index}_heating`], null);
    assert.equal(state.physical_zone_table_current, false);
});

test("all zone heating refreshes share the validated read-only B70 query and throttle", async () => {
    const query = controllerDefinition.toZigbee[0];
    for (let index = 1; index <= 8; index++) {
        clearProbeState();
        const {controller} = fixture();
        await query.convertGet(controller.endpoint, `zone_${index}_heating`, {device: controller});
        assert.equal(controller.tx.length, 1);
        assert.equal(controller.tx[0].payload.toString("hex"), "014237307eaaaaa88000000078");
        await assert.rejects(query.convertGet(controller.endpoint, "zone_table", {device: controller}), /five seconds/);
        await assert.rejects(query.convertGet(controller.endpoint, `zone_${index % 8 + 1}_heating`, {device: controller}), /five seconds/);
        assert.equal(controller.tx.length, 1);
    }
});

test("heating refresh cannot query another controller, a thermostat or unsupported zone", async () => {
    const {controller, thermostat, groundController} = twoFloors();
    const query = controllerDefinition.toZigbee[0], other = groundControllerDefinition.toZigbee[0];
    for (const [entity, key, device] of [[thermostat.endpoint, "zone_1_heating", thermostat],
        [groundController.endpoint, "zone_1_heating", groundController],
        [controller.endpoint, "zone_0_heating", controller], [controller.endpoint, "zone_9_heating", controller],
        [controller.endpoint, "zone_1_flag", controller]]) {
        await assert.rejects(query.convertGet(entity, key, {device}), /exact validated physical/);
    }
    await assert.rejects(other.convertGet(controller.endpoint, "zone_1_heating", {device: controller}), /exact validated physical/);
    assert.equal(controller.tx.length, 0); assert.equal(thermostat.tx.length, 0); assert.equal(groundController.tx.length, 0);
});

test("zone heating exposes are readable refreshable indicators and raw flags remain diagnostic", () => {
    for (const definition of [controllerDefinition, groundControllerDefinition]) {
        for (let index = 1; index <= 8; index++) {
            const heating = definition.exposes.find(expose => expose.property === `zone_${index}_heating`);
            assert.equal(heating.type, "binary");
            assert.equal(heating.access, 5, "STATE_GET only");
            assert.equal(heating.value_on, true); assert.equal(heating.value_off, false);
            assert.equal(heating.label, `Zone ${index} heating`);
            assert.equal(definition.exposes.find(expose => expose.property === `zone_${index}_flag`).category, "diagnostic");
        }
        assert.equal(definition.toZigbee[0].convertSet, undefined);
        const time = definition.exposes.find(expose => expose.property === "zone_table_seen");
        assert.equal(time.label, "Zone snapshot time");
        assert.match(time.description, /until refreshed/);
    }
});
