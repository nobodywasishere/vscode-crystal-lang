import * as vscode from "vscode";
import { tmpdir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'node:child_process';
import { error } from "console";
import * as junit2json from 'junit2json';

enum ItemType {
    File,
    TestCase
}

export class CrystalTestingProvider {
    private config = vscode.workspace.getConfiguration("crystal-lang")
    private controller = vscode.tests.createTestController(
        'crystalSpecs',
        'Crystal Specs'
    )
    private specLog = vscode.window.createOutputChannel("Crystal Spec");

    constructor() {
        // this.controller.resolveHandler = test => {
        //     if (!test) {
        //         this.getTestCases();
        //     } else {
        //         this.getTestCases([test.uri.path]);
        //     }
        // };

        // vscode.workspace.onDidChangeTextDocument(e => this.getTestCases([e.document.uri.path]));
        this.getTestCases();
    }

    log(data: string) {
        this.specLog.appendLine(data)
    }

    // changeWorkspace(e: vscode.WorkspaceFoldersChangeEvent) {
    //     e.
    // }

    async getTestCases(args?: string[]): Promise<void> {
        const tempFolder = fs.mkdtempSync(`${tmpdir()}${path.sep}crystal-spec-`) + path.sep + "junit";
        const crystal = this.config["compiler"]
        let commandArgs = ["spec", "--junit_output", tempFolder]
        if (args && args.length > 0) {
            commandArgs.concat(args)
        }
        this.log(`Running command: ${crystal} ${commandArgs.join(' ')}`)

        return new Promise((resolve, reject) => {
            this.execCrystal(crystal, commandArgs)
            .then(() => this.readTestResults(tempFolder))
            .then(junit => this.parseJunit(junit))
            .then(parsedJunit => this.convertJunitTestcases(parsedJunit))
            .then(() => {
                this.log("Success!");
                return Promise.resolve();
            })
            .catch((err) => {
                this.log("Error: " + error.toString() + "\n" + JSON.stringify(error));
                return Promise.reject(error);
            })
        })
    };

    async execTestCases(args?: string[]): Promise<junit2json.TestSuite> {
        const tempFolder = fs.mkdtempSync(`${tmpdir()}${path.sep}crystal-spec-`) + path.sep + "junit";
        const crystal = this.config["compiler"]
        let commandArgs = ["spec", "--junit_output", tempFolder]
        if (args && args.length > 0) {
            commandArgs = commandArgs.concat(args)
        }
        this.log(`Running command: ${crystal} ${commandArgs.join(' ')}`)

        try {
            await this.execCrystal(crystal, commandArgs);
            const junit = await this.readTestResults(tempFolder);
            return await this.parseJunit(junit);
        } catch (err) {
            this.log("Error: " + error.toString() + "\n" + JSON.stringify(error));
            return await Promise.reject(error);
        }
    }

    runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run,
        async (request, token) => {
            const run = this.controller.createTestRun(request);
            const queue: vscode.TestItem[] = [];

            const start = Date.now();
            const result = await this.execTestCases()
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

            this.log("Finished execution")
            run.end();
        }
    );

    execCrystal(command: string, commandArgs: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const process = spawn(command, commandArgs, {
                cwd: vscode.workspace.workspaceFolders[0].uri.path
            });

            let output = '';

            process.stdout.on('data', (data: Buffer) => {
                output += data.toString();
            })

            process.stderr.on('data', (data: Buffer) => {
                output += data.toString();
            })

            process.on('error', (error) => {
                this.log("Error executing crystal command: " + error.message + "\n" + output);
                reject("Error executing crystal command: " + error.message + "\n" + output);
            })

            process.on('close', () => {
                resolve(output);
            })
        })
    }

    readTestResults(folder: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            fs.readFile(`${folder}/output.xml`, (error, data) => {
                if (error) {
                    this.log("Error reading test results file")
                    reject("Error reading test results file: " + error.message);
                } else {
                    resolve(data);
                }
            })
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
                return reject("Could not find testcase " + id)
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
                testsuite.testcase.forEach((testcase) => {
                    this.log(JSON.stringify(testcase))
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

                    let fullPath = vscode.workspace.workspaceFolders[0].uri.path + path.sep + 'spec';
                    let parent: vscode.TestItem | null = null

                    // split the testcase.file and iterate over every folder in workspace
                    // @ts-expect-error
                    testcase.file.replace(fullPath, "").split(path.sep).filter((folder => folder !== "")).forEach((node: string) => {
                        // build full path of folder
                        fullPath += path.sep + node
                        this.log("Node: " + node)
                        this.log("fullPath: " + fullPath)

                        // check if folder exists in test controller
                        const exists = this.controller.items.get(fullPath)
                        if (exists) {
                            // if it does, get it
                            this.log("Node exists: " + exists.uri.path)
                            parent = exists
                        } else if (parent) {
                            let childMatch = null
                            parent.children.forEach((child) => {
                                if (childMatch === null && child.id === fullPath) {
                                    childMatch = child
                                }
                            })

                            if (childMatch !== null) {
                                this.log("Found match in parent children: " + childMatch.uri.path)
                                parent = childMatch
                            } else {
                                // if it doesn't and has a parent, create an item and make it a child of the parent
                                let child = this.controller.createTestItem(fullPath, node, vscode.Uri.file(fullPath))
                                this.log("Creating node under parent: " + parent.uri.path + " => " + node)
                                parent.children.add(child)
                                parent = child
                            }
                        } else {
                            // if don't already have a parent, use controller.items
                            this.log("Creating node under root: " + fullPath)
                            let child = this.controller.createTestItem(fullPath, node, vscode.Uri.file(fullPath))
                            this.controller.items.add(child)
                            parent = child
                        }
                    })

                    // add testcases to last parent
                    // @ts-expect-error
                    this.log("Adding testcase " + testcase.file + " to " + parent.uri.path)
                    parent.children.add(item)
                    this.log("")
                })
                resolve()
            } catch (err) {
                reject(err)
            }
        })
    }
}
