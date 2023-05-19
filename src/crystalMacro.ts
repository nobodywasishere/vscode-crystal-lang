import * as vscode from "vscode";
import { spawnSync } from 'node:child_process';

export async function registerCrystalMacro(context: vscode.ExtensionContext) {
    // let disposable = vscode.commands.registerCommand('crystal-lang.expandMacro', async () => {
    //     let editor = vscode.window.activeTextEditor;

    //     if (editor) {
    //         let filePath = editor.document.fileName;

    //         let position = editor.selection.active;
    //         let line = position.line + 1;
    //         let column = position.character + 1;

    //         // Run the command and capture its output
    //         let result = spawnSync(
    //             'crystal', ['tool', 'expand', `${filePath}`, '--cursor', `${filePath}:${line}:${column}`],
    //             { cwd: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)).uri.path }
    //         );

    //         if (result.status !== 0) {
    //             // Log any errors that occur
    //             console.error(result.stderr.toString());
    //             return;
    //         }

    //         let markdownResult = "```\n" + result.output.toString() + "\n```"

    //         // Get the range of the current line
    //         let lineText = editor.document.lineAt(position).text;
    //         let lineStart = editor.document.offsetAt(new vscode.Position(position.line, 0));
    //         let lineEnd = lineStart + lineText.length;
    //         let range = new vscode.Range(editor.document.positionAt(lineStart), editor.document.positionAt(lineEnd));

    //         let hover = new vscode.Hover(new vscode.MarkdownString(markdownResult), range)

    //     }
    // })
    // context.subscriptions.push(disposable)
    vscode.languages.registerHoverProvider({ scheme: 'file', language: 'crystal' }, {
        provideHover(document, position, token) {
            return expandMacro(document, position);
        }
    })
}

function expandMacro(document: vscode.TextDocument, position: vscode.Position): vscode.Hover {
    let filePath = document.uri.path;
    let line = position.line + 1;
    let column = position.character + 1;

    let result = spawnSync(
        'crystal', ['tool', 'expand', `${filePath}`, '--cursor', `${filePath}:${line}:${column}`],
        { cwd: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath)).uri.path }
    );

    if (result.status !== 0) {
        console.error(result.stderr.toString());
        return;
    }

    console.log(JSON.stringify(result))

    let stdout = result.output.join('\n').replace(/^\n+|\n+$/g, '');
    console.log(stdout)
    if (stdout.includes("no expansion found")) {
        console.log(`No macro expansion at ${filePath}:${line}:${column}`)
        return;
    }

    let markdownResult = new vscode.MarkdownString("```\n" + stdout + "\n```");

    let lineText = document.lineAt(position).text;
    let lineStart = document.offsetAt(new vscode.Position(position.line, 0));
    let lineEnd = lineStart + lineText.length;
    let range = new vscode.Range(document.positionAt(lineStart), document.positionAt(lineEnd));

    return new vscode.Hover(markdownResult, range)
}
