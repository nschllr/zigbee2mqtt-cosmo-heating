// SPDX-License-Identifier: MIT
import {mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {normalizeConfiguration} from "../src/converter.mjs";

const sourcePath = fileURLToPath(new URL("../src/converter.mjs", import.meta.url));
const usage = "Usage: npm run build -- [--config config.local.json] [--output dist/cosmo.mjs]";

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
        console.log(usage);
        return;
    }
    const options = {"--config": "config.local.json", "--output": "dist/cosmo.mjs"};
    const seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
        const key = args[i], value = args[i + 1];
        if (!Object.hasOwn(options, key) || seen.has(key) || !value || value.startsWith("--")) throw new Error(usage);
        seen.add(key);
        options[key] = value;
    }
    const configPath = path.resolve(options["--config"]);
    const outputPath = path.resolve(options["--output"]);
    if (!outputPath.endsWith(".mjs")) throw new Error("Output must be an .mjs file");
    // Check resolved paths and inode identity before writing anything.
    const actual = async (p) => realpath(p).catch((error) => {
        if (error.code === "ENOENT") return p;
        throw error;
    });
    const identity = async (p) => stat(p).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
    });
    const outputIdentity = await identity(outputPath);
    const protectedIdentities = await Promise.all([sourcePath, configPath].map(identity));
    if ([await actual(sourcePath), await actual(configPath)].includes(await actual(outputPath)) ||
        protectedIdentities.some((entry) => entry && outputIdentity && entry.dev === outputIdentity.dev && entry.ino === outputIdentity.ino)) {
        throw new Error("Output cannot overwrite the source or configuration");
    }
    let input;
    try {input = JSON.parse(await readFile(configPath, "utf8"));}
    catch (error) {
        if (error.code === "ENOENT") throw new Error("Configuration missing. Copy config.example.json to config.local.json and edit it first.");
        throw new Error("Configuration must be a readable JSON file");
    }
    const config = normalizeConfiguration(input);
    const source = await readFile(sourcePath, "utf8");
    const banner = "// Generated locally. Contains installation-specific device addresses; do not commit or share this file.\n";
    // JSON serialization is JavaScript data, never evaluated as user-supplied code.
    const output = banner + source + "\nexport default createConverter(" + JSON.stringify(config, null, 2) + ");\n";
    await mkdir(path.dirname(outputPath), {recursive: true});
    // Replace atomically so a failed build cannot leave a partial converter, and
    // an existing output symlink/hard link cannot cause another file to be written.
    const temporaryDirectory = await mkdtemp(path.join(path.dirname(outputPath), ".cosmo-build-"));
    try {
        const temporaryOutput = path.join(temporaryDirectory, "converter.mjs");
        await writeFile(temporaryOutput, output, {mode: 0o600});
        await rename(temporaryOutput, outputPath);
    } finally {
        await rm(temporaryDirectory, {recursive: true, force: true});
    }
    console.log(`Built ${outputPath} for ${config.controllers.length} controller(s). Keep the generated file private.`);
}

main().catch((error) => {console.error(error.message); process.exitCode = 1;});
