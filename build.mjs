// Type-checks the plugin against Figma's typings and writes code.js, which
// Figma runs as a script, not a module. The source imports types only, so it
// transpiles without a bundler.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "."], { stdio: "inherit" });

const js = ts
  .transpileModule(readFileSync("src/code.ts", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.ES2020, removeComments: true },
  })
  .outputText.replace(/^export \{\};?\s*$/gm, "");
if (/^\s*(import|export)\s/m.test(js)) throw new Error("src/code.ts must import types only");
// Figma refuses a plugin whose code merely looks like a dynamic import, or
// like an HTML comment, even in a string.
if (/\bimport\s*\(/.test(js) || /<!--|-->/.test(js)) throw new Error("src/code.ts has text that looks like import(…) or an HTML comment");
writeFileSync("code.js", js);
console.log(`code.js (${(js.length / 1024).toFixed(1)} KB)`);
