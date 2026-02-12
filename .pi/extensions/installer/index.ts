/**
 * Installer - Symlinks all pack resources to ~/.pi/agent/
 *
 * Usage: /install (auto-available when pi is opened in this repo)
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "agents", "themes"];

function getPackDir(): string {
	return path.resolve(__dirname, "..", "..", "..", "pack");
}

function linkResources(packDir: string): string[] {
	const piDir = path.join(os.homedir(), ".pi", "agent");
	const results: string[] = [];

	for (const type of RESOURCE_TYPES) {
		const srcDir = path.join(packDir, type);
		if (!fs.existsSync(srcDir)) continue;

		const destDir = path.join(piDir, type);
		fs.mkdirSync(destDir, { recursive: true });

		for (const name of fs.readdirSync(srcDir)) {
			if (name.startsWith(".")) continue;

			const srcPath = path.join(srcDir, name);
			let srcStat: fs.Stats;
			try {
				srcStat = fs.lstatSync(srcPath);
			} catch {
				continue;
			}

			if (!srcStat.isDirectory() && !srcStat.isFile()) continue;

			const target = path.join(destDir, name);
			const label = `${type}/${name}`;
			const linkType = srcStat.isDirectory() ? "junction" : "file";

			if (fs.existsSync(target)) {
				const stat = fs.lstatSync(target);
				if (stat.isSymbolicLink()) {
					fs.unlinkSync(target);
					fs.symlinkSync(srcPath, target, linkType);
					results.push(`↻ ${label} (updated)`);
				} else {
					results.push(`✗ ${label} (skipped, non-symlink exists)`);
				}
			} else {
				fs.symlinkSync(srcPath, target, linkType);
				results.push(`+ ${label}`);
			}
		}
	}

	return results;
}

function installDependencies(packDir: string): string[] {
	const results: string[] = [];

	for (const type of RESOURCE_TYPES) {
		const srcDir = path.join(packDir, type);
		if (!fs.existsSync(srcDir)) continue;

		for (const name of fs.readdirSync(srcDir)) {
			if (name.startsWith(".")) continue;
			const itemDir = path.join(srcDir, name);
			const pkgJson = path.join(itemDir, "package.json");
			const nodeModules = path.join(itemDir, "node_modules");

			if (fs.existsSync(pkgJson) && !fs.existsSync(nodeModules)) {
				try {
					execSync("npm install --production", { cwd: itemDir, stdio: "pipe" });
					results.push(`📦 ${type}/${name} (npm install)`);
				} catch (e: any) {
					results.push(`✗ ${type}/${name} (npm install failed: ${e.message})`);
				}
			}
		}
	}

	return results;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("install", {
		description: "Symlink all pack resources to ~/.pi/agent/",
		handler: async (_args, ctx) => {
			const packDir = getPackDir();
			if (!fs.existsSync(packDir)) {
				ctx.ui.notify("Pack directory not found.", "error");
				return;
			}

			// Pull latest changes first
			const repoDir = path.resolve(packDir, "..");
			try {
				const pullOutput = execSync("git pull", { cwd: repoDir, stdio: "pipe" }).toString().trim();
				if (pullOutput && pullOutput !== "Already up to date.") {
					ctx.ui.notify(`git pull: ${pullOutput}`, "info");
				}
			} catch (e: any) {
				ctx.ui.notify(`git pull failed: ${e.message}`, "error");
			}

			const results = linkResources(packDir);
			const depResults = installDependencies(packDir);
			const allResults = [...results, ...depResults];

			if (allResults.length === 0) {
				ctx.ui.notify("Nothing to install.", "info");
			} else {
				ctx.ui.notify(allResults.join("\n"), "info");
			}
		},
	});
}
