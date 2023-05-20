import * as vscode from "vscode";
import { tmpdir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'node:child_process';
import * as junit2json from 'junit2json';

export class CrystalTestingProvider {
    private config = vscode.workspace.getConfiguration("crystal-lang")
    private controller = vscode.tests.createTestController(
        'crystalSpecs',
        'Crystal Specs'
    )
    private specLog = vscode.window.createOutputChannel("Crystal Spec");
    private workspaceFolders: vscode.WorkspaceFolder[]
    private executingCrystal = false

    constructor() {
        if (!this.config["specs"]) {
            return;
        }

        this.refreshSpecWorkspaceFolders()
        this.refreshTestCases()

        vscode.workspace.onDidSaveTextDocument(e => {
            if (e.uri.scheme === "file" && this.isSpecFile(e.uri.path)) {
                this.deleteTestItem(e.uri.path);
                this.getTestCases(vscode.workspace.getWorkspaceFolder(e.uri).uri, [e.uri.path])
            }
        });

        vscode.workspace.onDidChangeWorkspaceFolders((event) => {
            this.refreshSpecWorkspaceFolders()
            event.added.forEach((folder) => {
                this.log("Adding folder to workspace: " + folder.uri.path)
                this.getTestCases(folder.uri)
            })
            event.removed.forEach((folder) => {
                this.log("Removing folder from workspace: " + folder.uri.path)
                this.deleteWorkspaceChildren(folder)
            })
        });

        this.controller.refreshHandler = async () => {
            this.refreshSpecWorkspaceFolders()
            this.controller.items.forEach((item) => {
                this.controller.items.delete(item.id)
            })
            this.refreshTestCases()
        }

    }

    log(data: string) {
        this.specLog.appendLine(data)
    }

    refreshSpecWorkspaceFolders(): void {
        let folders = []
        vscode.workspace.workspaceFolders.forEach((folder) => {
            if (fs.existsSync(`${folder.uri.path}${path.sep}shard.yml`) &&
                fs.existsSync(`${folder.uri.path}${path.sep}spec`)) {
                folders.push(folder)
            }
        })
        this.workspaceFolders = folders
    }

    isSpecFile(file: string): boolean {
        return file.endsWith('_spec.cr') &&
            this.workspaceFolders.includes(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)))
    }

    async refreshTestCases(): Promise<void> {
        return new Promise(async () => {
            for (var i = 0; i < this.workspaceFolders.length; i++) {
                await this.getTestCases(this.workspaceFolders[i].uri)
            }
        })
    }

    private deleteTestItem(id: string) {
        this.controller.items.forEach((child) => {
            var item = this.getChild(id, child);
            if (item !== undefined) {
                item.children.forEach((c) => {
                    item.children.delete(c.id);
                });
            } else if (child.id === id) {
                this.controller.items.delete(id)
            }
        });
    }

    private deleteWorkspaceChildren(workspace: vscode.WorkspaceFolder) {
        this.controller.items.forEach((child) => {
            if (child.uri.path.startsWith(workspace.uri.path)) {
                this.deleteTestItem(child.uri.path)
            }
        })
    }

    async getTestCases(workspace: vscode.Uri, args?: string[]): Promise<void> {
        const tempFolder = fs.mkdtempSync(`${tmpdir()}${path.sep}crystal-spec-`) + path.sep + "junit";
        const crystal = this.config["compiler"]
        let commandArgs = ["spec", "--junit_output", tempFolder]
        if (args && args.length > 0) {
            commandArgs = commandArgs.concat(args)
        }

        return new Promise((resolve, reject) => {
            this.execCrystal(workspace, crystal, commandArgs)
                .then(() => this.readTestResults(tempFolder))
                .then(junit => this.parseJunit(junit))
                .then(parsedJunit => this.convertJunitTestcases(parsedJunit))
                .then(() => {
                    this.log("Success!");
                    resolve();
                })
                .catch((err) => {
                    this.log("Error: " + err.message + "\n" + err.stack);
                    reject(err);
                })
        })
    };

    async execTestCases(workspace: vscode.Uri, args?: string[]): Promise<junit2json.TestSuite> {
        const tempFolder = fs.mkdtempSync(`${tmpdir()}${path.sep}crystal-spec-`) + path.sep + "junit";
        const crystal = this.config["compiler"]
        let commandArgs = ["spec", "--junit_output", tempFolder]
        if (args && args.length > 0) {
            commandArgs = commandArgs.concat(args)
        }

        try {
            await this.execCrystal(workspace, crystal, commandArgs);
            const junit = await this.readTestResults(tempFolder);
            return await this.parseJunit(junit);
        } catch (err) {
            this.log("Error: " + err.message + "\n" + err.stack);
            return await Promise.reject(err);
        }
    }

    runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run,
        async (request, token) => {
            const run = this.controller.createTestRun(request);
            const start = Date.now();

            let runnerArgs = []
            this.controller.items.forEach((item) => {
                let generated = this.generateRunnerArgs(item, request.include, request.exclude)
                if (generated.length > 0) {
                    runnerArgs = runnerArgs.concat(generated)
                }
            })

            let workspaces: vscode.WorkspaceFolder[] = []
            runnerArgs.forEach((arg) => {
                const uri = vscode.Uri.file(arg)
                const workspace = vscode.workspace.getWorkspaceFolder(uri)
                if (workspace !== undefined && !workspaces.includes(workspace)) {
                    workspaces.push(workspace)
                }
            })

            for (var i = 0; i < workspaces.length; i++) {
                let args = []
                runnerArgs.forEach((arg) => {
                    if (workspaces[i] == vscode.workspace.getWorkspaceFolder(vscode.Uri.file(arg))) {
                        args.push(arg)
                    }
                })
                let result: junit2json.TestSuite
                try {
                    result = await this.execTestCases(workspaces[i].uri, args)
                } catch (err) {
                    this.log("Error: " + err.message)
                    run.end()
                    return
                }

                result.testcase.forEach((testcase) => {
                    let exists = undefined
                    this.controller.items.forEach((child: vscode.TestItem) => {
                        if (exists === undefined) {
                            // @ts-expect-error
                            exists = this.getChild(testcase.file + " " + testcase.name, child)
                        }
                    })

                    if (exists) {
                        if (!(request.include && request.include.includes(exists)) || !(request.exclude?.includes(exists))) {
                            if (testcase.error) {
                                run.failed(exists,
                                    new vscode.TestMessage(
                                        testcase.error.map((v) => `${v.inner}\n${v.message}`).join("\n\n")
                                    ),
                                    testcase.time * 1000)
                            } else if (testcase.failure) {
                                run.failed(exists,
                                    new vscode.TestMessage(
                                        testcase.failure.map((v) => `${v.inner}\n${v.message}`).join("\n\n")
                                    ),
                                    testcase.time * 1000)
                            } else {
                                run.passed(exists, testcase.time * 1000)
                            }
                        }
                    }
                })
            }

            this.log(`Finished execution in ${Date.now() - start}ms`)
            run.end();
        }
    );

    generateRunnerArgs(item: vscode.TestItem, includes: readonly vscode.TestItem[], excludes: readonly vscode.TestItem[]): string[] {
        if (includes) {
            if (includes.includes(item)) {
                return [item.uri.path]
            } else {
                let foundChildren = []
                item.children.forEach((child) => {
                    foundChildren = foundChildren.concat(this.generateRunnerArgs(child, includes, excludes))
                })
                return foundChildren
            }
        } else if (excludes.length > 0) {
            if (excludes.includes(item)) {
                return []
            } else {
                let foundChildren = []
                item.children.forEach((child) => {
                    foundChildren = foundChildren.concat(this.generateRunnerArgs(child, includes, excludes))
                })
                return foundChildren
            }
        } else {
            return [item.uri.path]
        }
    }

    execCrystal(workspace: vscode.Uri, command: string, commandArgs: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            if (this.executingCrystal) {
                this.log("Crystal is already being executed")
                return
            }

            this.executingCrystal = true

            this.log(`Executing in ${workspace.path}: ${command} ${commandArgs.join(' ')}`)

            const process = spawn(command, commandArgs, {
                cwd: workspace.path
            });

            let output = '';

            process.stdout.on('data', (data: Buffer) => {
                output += data.toString();
            })

            process.stderr.on('data', (data: Buffer) => {
                output += data.toString();
            })

            process.on('error', (error) => {
                this.executingCrystal = false
                reject(new Error("Error executing crystal command: " + error.message + "\n" + output));
            })

            process.on('exit', (code, signal) => {
                if (code > 1) {
                    this.executingCrystal = false
                    reject(new Error(`Exited with error code ${code}: ${output}`))
                } else {
                    this.executingCrystal = false
                    resolve(output);
                }
            })
        })
    }

    readTestResults(folder: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            try {
                if (!fs.existsSync(`${folder}/output.xml`)) {
                    reject(new Error("Test results file doesn't exist"))
                }
                fs.readFile(`${folder}/output.xml`, (error, data) => {
                    if (error) {
                        reject(new Error("Error reading test results file: " + error.message));
                    } else {
                        resolve(data);
                    }
                })
            } catch (err) {
                reject(err)
            }
        })
    }

    parseJunit(rawXml: Buffer): Promise<junit2json.TestSuite> {
        return new Promise(async (resolve, reject) => {
            try {
                const output = await junit2json.parse(rawXml);
                resolve(output as junit2json.TestSuite);
            } catch (err) {
                reject(err)
            }
        })
    }

    getTestCaseFromJunit(id: string, junit: junit2json.TestSuite): Promise<junit2json.TestCase> {
        return new Promise((resolve, reject) => {
            try {
                junit.testcase.forEach((testcase) => {
                    // @ts-expect-error
                    if ((testcase.file + " " + testcase.name) === id) {
                        return resolve(testcase)
                    }
                })
                return reject(new Error("Could not find testcase " + id))
            } catch (err) {
                return reject(err)
            }
        })
    }

    getChild(id: string, parent: vscode.TestItem): vscode.TestItem | undefined {
        let foundChild = parent.children.get(id)
        if (foundChild) {
            return foundChild
        }
        parent.children.forEach((child) => {
            if (foundChild === undefined) {
                foundChild = this.getChild(id, child)
            }
        })
        return foundChild
    }

    convertJunitTestcases(testsuite: junit2json.TestSuite): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                if (testsuite.tests === 0) {
                    this.log(`Error: No testcases in testsuite ${JSON.stringify(testsuite)}`)
                    return
                }

                testsuite.testcase.forEach((testcase) => {
                    // this.log(JSON.stringify(testcase))
                    const item = this.controller.createTestItem(
                        // @ts-expect-error
                        testcase.file + " " + testcase.name,
                        testcase.name,
                        // @ts-expect-error
                        vscode.Uri.file(testcase.file)
                    )

                    if (testcase.hasOwnProperty('line')) {
                        item.range = new vscode.Range(
                            // @ts-expect-error
                            new vscode.Position(testcase.line - 1, 0),
                            // @ts-expect-error
                            new vscode.Position(testcase.line - 1, 0)
                        );
                    }

                    // @ts-expect-error
                    let fullPath = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(testcase.file)).uri.path +
                        path.sep + 'spec';
                    let parent: vscode.TestItem | null = null

                    // split the testcase.file and iterate over every folder in workspace
                    // @ts-expect-error
                    testcase.file.replace(fullPath, "").split(path.sep).filter((folder => folder !== "")).forEach((node: string) => {
                        // build full path of folder
                        fullPath += path.sep + node
                        // this.log("Node: " + node)
                        // this.log("fullPath: " + fullPath)

                        // check if folder exists in test controller
                        const exists = this.controller.items.get(fullPath)
                        if (exists) {
                            // if it does, get it
                            // this.log("Node exists: " + exists.uri.path)
                            parent = exists
                        } else if (parent) {
                            let childMatch = null
                            parent.children.forEach((child) => {
                                if (childMatch === null && child.id === fullPath) {
                                    childMatch = child
                                }
                            })

                            if (childMatch !== null) {
                                // this.log("Found match in parent children: " + childMatch.uri.path)
                                parent = childMatch
                            } else {
                                // if it doesn't and has a parent, create an item and make it a child of the parent
                                let child = this.controller.createTestItem(fullPath, node, vscode.Uri.file(fullPath))
                                // this.log("Creating node under parent: " + parent.uri.path + " => " + node)
                                parent.children.add(child)
                                parent = child
                            }
                        } else {
                            // if don't already have a parent, use controller.items
                            // this.log("Creating node under root: " + fullPath)
                            let child = this.controller.createTestItem(fullPath, node, vscode.Uri.file(fullPath))
                            this.controller.items.add(child)
                            parent = child
                        }
                    })

                    // add testcases to last parent
                    // this.log("Adding testcase " + testcase.file + " to " + parent.uri.path)
                    parent.children.add(item)
                    // this.log("")
                })
                resolve()
            } catch (err) {
                reject(err)
            }
        })
    }
}
