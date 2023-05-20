import * as vscode from "vscode"
import { spawn } from 'node:child_process';

import { spawnTools } from "./crystalUtils"

/**
 * Call tool for get Crystal context
 */
export class CrystalContext {

	/**
	 * Execute crystal tool context for current file:position
	 */
	crystalContext(document: vscode.TextDocument, position: vscode.Position, key) {
		return spawnTools(document, position, "context", key)
	}
}
