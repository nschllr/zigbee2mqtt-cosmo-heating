// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {test} from "node:test";
import {closeSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/build.mjs");
const config = () => ({
    clock: {timeZone: "UTC", standardUtcOffsetMinutes: 0, daylightSavingOffsetMinutes: 0},
    controllers: [{wcNumber: 1, controllerIeee: "0x0200000000000001", thermostatIeees: ["0x0200000000000011"]},
        {wcNumber: 2, controllerIeee: "0x0200000000000002", thermostatIeees: ["0x0200000000000021"]}],
});
// File-backed stdout also works on hosts where subprocess pipe capture is limited.
// Keeping CLI output observable ensures errors and --help remain genuinely tested.
function runScript(command, ...args) {
    const directory = mkdtempSync(path.join(tmpdir(), "cosmo-cli-test-"));
    const stdout = path.join(directory, "stdout"), stderr = path.join(directory, "stderr");
    const outFd = openSync(stdout, "w", 0o600), errFd = openSync(stderr, "w", 0o600);
    try {
        const result = spawnSync(process.execPath, [command, ...args], {
            cwd: root, stdio: ["ignore", outFd, errFd], timeout: 15000,
        });
        return {...result, stdout: readFileSync(stdout, "utf8"), stderr: readFileSync(stderr, "utf8")};
    } finally {
        closeSync(outFd); closeSync(errFd);
        rmSync(directory, {recursive: true, force: true});
    }
}
const run = (...args) => runScript(script, ...args);
function temporary(t) {
    mkdirSync(path.join(root, "dist"), {recursive: true});
    const directory = mkdtempSync(path.join(root, "dist/test-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const input = path.join(directory, "config.json"), output = path.join(directory, "cosmo.mjs");
    writeFileSync(input, JSON.stringify(config()), {mode: 0o600});
    return {directory, input, output};
}

test("builder produces an importable standalone converter containing only its configured mappings", async t => {
    const {input, output} = temporary(t);
    const result = run("--config", input, "--output", output);
    assert.equal(result.status, 0, result.stderr);
    const built = await import(pathToFileURL(output).href);
    assert.equal(built.default.length, 4);
    assert.ok(built.default.every(definition => Array.isArray(definition.fingerprint)));
    const text = readFileSync(output, "utf8");
    assert.equal(/(?:from\s*|import\s*\()\s*["']\.\.?\//.test(text), false, "Generated file must not need local companion modules");
    assert.equal(/node:fs|readFileSync|config\.local\.json/.test(text), false, "Generated runtime must not load local configuration files");
    assert.ok(text.includes("0x0200000000000001"));
    assert.ok(text.includes("0x0200000000000002"));
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
});

test("builder refuses malformed JSON or conflicting configuration before producing output", t => {
    const {input, output} = temporary(t);
    for (const contents of ["{", JSON.stringify({}), JSON.stringify({...config(), controllers: [config().controllers[0], config().controllers[0]]})]) {
        writeFileSync(input, contents);
        const result = run("--config", input, "--output", output);
        assert.notEqual(result.status, 0);
        assert.throws(() => statSync(output), {code: "ENOENT"});
    }
});

test("builder does not overwrite its source or input configuration", t => {
    const {input} = temporary(t);
    for (const protectedPath of [input, path.join(root, "src/converter.mjs")]) {
        const original = readFileSync(protectedPath);
        const result = run("--config", input, "--output", protectedPath);
        assert.notEqual(result.status, 0);
        assert.deepEqual(readFileSync(protectedPath), original);
    }
});

test("builder's help and invalid argument paths do not produce a converter", t => {
    const {directory, output} = temporary(t);
    const help = run("--help");
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /config|usage/i);
    for (const args of [["--config"], ["--output"], ["--unknown"],
        ["--config", path.join(directory, "missing.json"), "--output", output]]) {
        const result = run(...args);
        assert.notEqual(result.status, 0);
    }
    assert.throws(() => statSync(output), {code: "ENOENT"});
});

test("builder refuses output hard-linked to its source or configuration", t => {
    // A deliberately broken guard must only damage isolated fixture copies.
    for (const protectedKind of ["source", "configuration"]) {
        const {directory, input} = temporary(t);
        const isolated = path.join(directory, "isolated");
        mkdirSync(path.join(isolated, "scripts"), {recursive: true});
        mkdirSync(path.join(isolated, "src"), {recursive: true});
        const copiedScript = path.join(isolated, "scripts/build.mjs");
        const copiedSource = path.join(isolated, "src/converter.mjs");
        copyFileSync(script, copiedScript);
        copyFileSync(path.join(root, "src/converter.mjs"), copiedSource);
        const protectedPath = protectedKind === "source" ? copiedSource : input;
        const before = readFileSync(protectedPath);
        const output = path.join(directory, "linked-output.mjs");
        linkSync(protectedPath, output);
        assert.equal(statSync(output).ino, statSync(protectedPath).ino);
        const result = runScript(copiedScript, "--config", input, "--output", output);
        assert.notEqual(result.status, 0, `Hard-linked ${protectedKind} must be rejected`);
        assert.deepEqual(readFileSync(protectedPath), before, protectedKind);
        assert.deepEqual(readFileSync(output), before);
    }
});
