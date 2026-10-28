// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {test} from "node:test";
import {createConverter, createInstallation, normalizeConfiguration} from "../src/converter.mjs";

const clock = {timeZone: "Europe/Berlin", standardUtcOffsetMinutes: 60, daylightSavingOffsetMinutes: 60};
const controller = (wcNumber = 1) => ({
    wcNumber,
    controllerIeee: wcNumber === 1 ? "0x020000000000000a" : "0x020000000000000b",
    thermostatIeees: [wcNumber === 1 ? "0x020000000000001a" : "0x020000000000002a"],
});
const config = () => ({clock: {...clock}, controllers: [controller()]});
const installation = (settings = clock) => createInstallation({...controller(), clock: settings});

// Config validation happens before the returned definitions can contact a device.
test("configuration normalizes uppercase addresses without changing caller-owned objects", () => {
    const input = config();
    input.controllers[0].controllerIeee = "0X020000000000000A";
    input.controllers[0].thermostatIeees = ["0X020000000000001A"];
    const snapshot = structuredClone(input);
    const normalized = normalizeConfiguration(input);
    assert.equal(normalized.controllers[0].controllerIeee, "0x020000000000000a");
    assert.deepEqual(normalized.controllers[0].thermostatIeees, ["0x020000000000001a"]);
    assert.deepEqual(input, snapshot);
    for (const value of [normalized, normalized.clock, normalized.controllers, normalized.controllers[0], normalized.controllers[0].thermostatIeees]) {
        assert.equal(Object.isFrozen(value), true);
    }
});

test("one or two configured controllers produce only their exact device fingerprints", () => {
    const one = createConverter(config());
    assert.equal(one.length, 2);
    const input = {...config(), controllers: [controller(), controller(2)]};
    const definitions = createConverter(input);
    assert.equal(definitions.length, 4);
    for (const [index, definition] of definitions.entries()) {
        const group = input.controllers[Math.floor(index / 2)];
        const expected = index % 2 === 0 ? group.thermostatIeees : [group.controllerIeee];
        assert.equal(definition.zigbeeModel, undefined);
        assert.equal(definition.ota, undefined);
        for (const fingerprint of definition.fingerprint) {
            assert.ok(expected.some(address => fingerprint.ieeeAddr.test(address)));
            assert.equal(fingerprint.ieeeAddr.test("0x0200000000000099"), false);
        }
    }
});

test("WC2 may be configured on its own without a fabricated WC1", () => {
    const definitions = createConverter({...config(), controllers: [controller(2)]});
    assert.equal(definitions.length, 2);
    assert.ok(definitions.every(definition => definition.model.endsWith("WC2")));
});

test("a thermostat cannot belong to two controllers even with a different address case", () => {
    const input = {...config(), controllers: [controller(), controller(2)]};
    input.controllers[1].thermostatIeees = ["0X020000000000001A"];
    assert.throws(() => normalizeConfiguration(input), /IEEE|installation/i);
});

test("controller addresses cannot collide across groups or with any thermostat", () => {
    for (const field of ["controller", "thermostat"]) {
        const input = {...config(), controllers: [controller(), controller(2)]};
        input.controllers[1].controllerIeee = field === "controller" ? "0X020000000000000A" : "0X020000000000001A";
        assert.throws(() => normalizeConfiguration(input), /IEEE|installation/i);
    }
});

test("controller numbers must be unique and restricted to the two verified slots", () => {
    const duplicate = {...config(), controllers: [controller(), {...controller(2), wcNumber: 1}]};
    assert.throws(() => normalizeConfiguration(duplicate), /number|unique/i);
    for (const wcNumber of [0, 3, 9, 10, 1.5, true, "1", null]) {
        const input = config(); input.controllers[0].wcNumber = wcNumber;
        assert.throws(() => normalizeConfiguration(input));
    }
});

test("invalid addresses and duplicates are rejected within each controller", () => {
    for (const address of [null, 3, "", "0x1234", "020000000000001a", "0x020000000000001g", "0x0000000000000000", "0xffffffffffffffff"]) {
        for (const key of ["controllerIeee", "thermostatIeees"]) {
            const input = config(); input.controllers[0][key] = key === "controllerIeee" ? address : [address];
            assert.throws(() => normalizeConfiguration(input));
        }
    }
    for (const addresses of [["0x020000000000001a", "0X020000000000001A"], ["0X020000000000000A"]]) {
        const input = config(); input.controllers[0].thermostatIeees = addresses;
        assert.throws(() => normalizeConfiguration(input), /distinct|duplicate/i);
    }
});

test("empty, sparse and incorrectly shaped controller/thermostat arrays are rejected", () => {
    for (const controllers of [[], new Array(1), null, {}, "controller", [null], [[controller()]]]) {
        assert.throws(() => normalizeConfiguration({...config(), controllers}));
    }
    for (const thermostatIeees of [[], new Array(1), null, {}, "0x020000000000001a"]) {
        const input = config(); input.controllers[0].thermostatIeees = thermostatIeees;
        assert.throws(() => normalizeConfiguration(input));
    }
});

test("missing configuration and unrecognized keys fail before creating definitions", () => {
    for (const input of [null, undefined, [], "config", {}, {controllers: [controller()]}, {clock: {...clock}}]) {
        assert.throws(() => normalizeConfiguration(input));
    }
    for (const mutate of [
        input => {input.typo = true;},
        input => {input.clock.typo = true;},
        input => {input.controllers[0].zone = 1;},
    ]) {
        const input = config(); mutate(input);
        assert.throws(() => normalizeConfiguration(input), /unknown/i);
    }
    assert.throws(() => createInstallation({...controller(), clock: {...clock}, typo: true}), /unknown/i);
});

test("clock settings must be explicit and use a supported native offset", () => {
    for (const settings of [null, {}, {...clock, timeZone: ""}, {...clock, timeZone: "Not/AZone"},
        {...clock, timeZone: "+01:00"}, {...clock, standardUtcOffsetMinutes: 61},
        {...clock, standardUtcOffsetMinutes: "60"}, {...clock, daylightSavingOffsetMinutes: 30},
        {...clock, daylightSavingOffsetMinutes: "60"}, {...clock, daylightSavingOffsetMinutes: 120}]) {
        assert.throws(() => installation(settings));
    }
});

test("clock's timezone and standard/daylight offsets must agree throughout the year", () => {
    for (const settings of [
        {...clock, standardUtcOffsetMinutes: 0},
        {...clock, daylightSavingOffsetMinutes: 0},
        {timeZone: "UTC", standardUtcOffsetMinutes: 0, daylightSavingOffsetMinutes: 60},
        {timeZone: "Australia/Lord_Howe", standardUtcOffsetMinutes: 630, daylightSavingOffsetMinutes: 60},
    ]) assert.throws(() => installation(settings), /offset|clock|time/i);
});

function assertClock(settings, date, expected) {
    const {syncPayload} = installation(settings);
    const actual = syncPayload(new Date(date), 1);
    const epoch2000 = Date.UTC(2000, 0, 1) / 1000;
    assert.equal(actual.length, 15);
    assert.equal(actual[0], 1);
    assert.equal(actual.readUInt32LE(2), Date.parse(date) / 1000 + expected.offsetSeconds - epoch2000);
    assert.equal(actual[6], 0x02 | (expected.daylight ? 1 : 0));
    assert.equal(actual[7], expected.index);
    assert.equal(actual[8], settings.daylightSavingOffsetMinutes / 60);
    assert.equal(actual.subarray(9, 13).toString("hex"), "ffffffff");
    assert.equal(actual[13], 0x31);
    assert.equal(actual[14], 0);
    assert.equal(syncPayload(new Date(date), 0x20)[0], 0x20);
}

test("Berlin synchronization encodes winter and summer wall time separately from standard offset", () => {
    assertClock(clock, "2030-01-15T12:00:00.000Z", {offsetSeconds: 3600, index: 14, daylight: false});
    assertClock(clock, "2030-07-15T12:00:00.000Z", {offsetSeconds: 7200, index: 14, daylight: true});
});

test("New York uses its negative standard offset and seasonal daylight flag", () => {
    const settings = {timeZone: "America/New_York", standardUtcOffsetMinutes: -300, daylightSavingOffsetMinutes: 60};
    assertClock(settings, "2030-01-15T12:00:00.000Z", {offsetSeconds: -18000, index: 8, daylight: false});
    assertClock(settings, "2030-07-15T12:00:00.000Z", {offsetSeconds: -14400, index: 8, daylight: true});
});

test("Sydney reverses the northern hemisphere's daylight seasons", () => {
    const settings = {timeZone: "Australia/Sydney", standardUtcOffsetMinutes: 600, daylightSavingOffsetMinutes: 60};
    assertClock(settings, "2030-01-15T12:00:00.000Z", {offsetSeconds: 39600, index: 23, daylight: true});
    assertClock(settings, "2030-07-15T12:00:00.000Z", {offsetSeconds: 36000, index: 23, daylight: false});
});

test("UTC works without daylight saving or a regional timezone assumption", () => {
    const settings = {timeZone: "UTC", standardUtcOffsetMinutes: 0, daylightSavingOffsetMinutes: 0};
    assertClock(settings, "2030-01-15T12:00:00.000Z", {offsetSeconds: 0, index: 13, daylight: false});
    assertClock(settings, "2030-07-15T12:00:00.000Z", {offsetSeconds: 0, index: 13, daylight: false});
});

test("fixed half- and quarter-hour standard offsets use exact native indices", () => {
    assertClock({timeZone: "Asia/Kolkata", standardUtcOffsetMinutes: 330, daylightSavingOffsetMinutes: 0},
        "2030-01-15T12:00:00.000Z", {offsetSeconds: 19800, index: 34, daylight: false});
    assertClock({timeZone: "Asia/Kathmandu", standardUtcOffsetMinutes: 345, daylightSavingOffsetMinutes: 0},
        "2030-01-15T12:00:00.000Z", {offsetSeconds: 20700, index: 35, daylight: false});
});

test("clock rejects invalid dates and values outside the unsigned seconds-since-2000 range", () => {
    const {syncPayload} = installation();
    for (const value of [new Date(NaN), new Date("1999-01-01T00:00:00Z"), new Date("2200-01-01T00:00:00Z"), "2030-01-15"]) {
        assert.throws(() => syncPayload(value));
    }
});
