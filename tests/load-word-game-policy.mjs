import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export function loadWordGamePolicy(root, context) {
  if (!context.window) context.window = context;
  vm.runInContext(
    fs.readFileSync(path.join(root, "wordGamePolicy.js"), "utf8"),
    context,
    { filename: "wordGamePolicy.js" },
  );
  return context.window.WordGamePolicy;
}
