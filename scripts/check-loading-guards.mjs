import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const storeDir = path.resolve("src/store");
const files = fs
  .readdirSync(storeDir)
  .filter((name) => name.endsWith(".ts"))
  .sort();
const violations = [];

function functionName(node) {
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) {
    return parent.name?.getText() ?? "<anonymous>";
  }
  if (ts.isVariableDeclaration(parent)) return parent.name.getText();
  return node.name?.getText?.() ?? "<anonymous>";
}

function containsCatch(node) {
  let found = false;
  const visit = (child) => {
    if (ts.isCatchClause(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

for (const file of files) {
  const fullPath = path.join(storeDir, file);
  const sourceText = fs.readFileSync(fullPath, "utf8");
  const source = ts.createSourceFile(fullPath, sourceText, ts.ScriptTarget.Latest, true);

  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const bodyText = node.body.getText(source);
      if (/set\s*\(\s*\{\s*loading\s*:\s*true\b/.test(bodyText) && !containsCatch(node.body)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${file}:${line + 1} ${functionName(node)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (violations.length > 0) {
  console.error(`loading guard violations: ${violations.length}`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("loading guard violations: 0");
}
