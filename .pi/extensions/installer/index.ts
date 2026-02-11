/**
 * Installer - Symlinks all pack resources to ~/.pi/agent/
 *
 * Usage: /install (auto-available when pi is opened in this repo)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const RESOURCE_TYPES = ["extensions", "skills", "agents", "themes"];

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
			const srcPath = path.join(srcDir, name);
			if (!fs.statSync(srcPath).isDirectory()) continue;

			const target = path.join(destDir, name);
			const label = `${type}/${name}`;

			if (fs.existsSync(target)) {
				const stat = fs.lstatSync(target);
				if (stat.isSymbolicLink()) {
					fs.unlinkSync(target);
					fs.symlinkSync(srcPath, target, "junction");
					results.push(`↻ ${label} (updated)`);
				} else {
					results.push(`✗ ${label} (skipped, non-symlink exists)`);
				}
			} else {
				fs.symlinkSync(srcPath, target, "junction");
				results.push(`+ ${label}`);
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

			const results = linkResources(packDir);

			if (results.length === 0) {
				ctx.ui.notify("Nothing to install.", "info");
			} else {
				ctx.ui.notify(results.join("\n"), "info");
			}
		},
	});
}
