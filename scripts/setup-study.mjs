import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = fileURLToPath(new URL("..", import.meta.url));
const lock = JSON.parse(readFileSync(resolve(root, "study.lock.json"), "utf8"));
for (const source of lock.sources) {
  const dir = resolve(root, source.directory);
  if (!existsSync(dir)) {
    execFileSync(
      "git",
      ["clone", "--filter=blob:none", "--no-checkout", source.repo, dir],
      { stdio: "inherit" },
    );
    execFileSync("git", ["-C", dir, "checkout", "--detach", source.commit], {
      stdio: "inherit",
    });
  }
  const actual = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (actual !== source.commit)
    throw Error("study dependency differs; refusing to overwrite " + dir);
  console.log(source.directory + " " + actual.slice(0, 7));
}
