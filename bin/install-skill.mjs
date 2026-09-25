#!/usr/bin/env node
/**
 * Installs this package's integration guide into the caller's project, so a coding agent working
 * there picks it up as a skill.
 *
 *   npx @hanexis/agentic-sdk-client --skill
 *
 * Copies the guides rather than pointing at node_modules: an agent reads what is in the repository,
 * and a file under node_modules is both invisible to it and wiped by the next clean install.
 *
 * No dependencies, by design — this package ships with zero runtime dependencies and a CLI is not
 * a reason to break that.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * SKILL.md is the index — the database-neutral half plus a pointer to the dialect guide beside it.
 * Both are installed together, because the index is not much use on its own and a reader who has to
 * go fetch the second file will not.
 */
const SKILL_FILES = ["SKILL.md", "SKILL-mongodb.md"];

/**
 * Where each tool looks for skills. Claude Code reads `.claude/skills/<name>/SKILL.md`; the others
 * use a single instructions file, so the guide is written under its own name beside them rather
 * than overwriting whatever the project already has there.
 */
const TARGETS = {
  claude: ".claude/skills/agentic-sdk-client",
  cursor: ".cursor/rules",
  copilot: ".github/instructions",
  agents: ".",
};

/**
 * Claude Code expects the entry file to be named SKILL.md inside its own directory; the others use
 * a flat rules folder shared with everything else, so the files are prefixed there to avoid
 * colliding with a project's own SKILL.md.
 */
function fileNameFor(target, sourceName) {
  if (target === "claude") return sourceName;
  return sourceName === "SKILL.md" ? "agentic-sdk-client.md" : `agentic-sdk-client-${sourceName.replace(/^SKILL-/, "")}`;
}

/**
 * Rewrites the guides' links to each other so they still resolve after install.
 *
 * The files reference each other as `./SKILL-mongodb.md` and `./SKILL.md`, which is correct inside
 * the package and inside Claude Code's own skill directory. Every other target flattens them into a
 * shared rules folder under prefixed names, where those links would 404 — and a broken link between
 * an index and the guide it points at defeats the split.
 */
function rewriteCrossLinks(contents, target) {
  if (target === "claude") return contents;
  return contents
    .replace(/\.\/SKILL-mongodb\.md/g, fileNameFor(target, "SKILL-mongodb.md"))
    .replace(/\.\/SKILL\.md/g, fileNameFor(target, "SKILL.md"));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const target = args.find((a) => a.startsWith("--target="))?.slice("--target=".length);
  return {
    skill: args.includes("--skill"),
    force: args.includes("--force"),
    help: args.includes("--help") || args.includes("-h") || args.length === 0,
    target: target ?? "claude",
  };
}

function usage() {
  console.log(`
  Install the Agentic SDK integration guide into this project.

    npx @hanexis/agentic-sdk-client --skill

  Options
    --target=<tool>   claude (default), cursor, copilot, agents
    --force           overwrite an existing copy
    --help            show this

  Writes two markdown files: an index and the guide for your database.
  Nothing else is touched.
`);
}

function main() {
  const { skill, force, help, target } = parseArgs(process.argv);
  if (help || !skill) {
    usage();
    process.exit(help ? 0 : 1);
  }

  const relativeTarget = TARGETS[target];
  if (!relativeTarget) {
    console.error(`Unknown --target "${target}". Expected one of: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }

  const planned = [];
  for (const sourceName of SKILL_FILES) {
    const source = join(packageRoot, sourceName);
    if (!existsSync(source)) {
      console.error(`${sourceName} is missing from the installed package — reinstall @hanexis/agentic-sdk-client.`);
      process.exit(1);
    }
    // `npx` runs with the caller's project as cwd, which is where the files belong.
    const destination = resolve(process.cwd(), relativeTarget, fileNameFor(target, sourceName));
    planned.push({ source, destination });
  }

  // Checked as a SET before writing anything: a half-installed pair is worse than a clean refusal,
  // because the index would then point at a guide that is missing or stale.
  const conflicts = planned.filter(
    ({ source, destination }) =>
      existsSync(destination) &&
      readFileSync(destination, "utf8") !== rewriteCrossLinks(readFileSync(source, "utf8"), target),
  );
  if (conflicts.length > 0 && !force) {
    for (const { destination } of conflicts) {
      console.error(`${relative(process.cwd(), destination)} already exists and differs.`);
    }
    console.error("Re-run with --force to overwrite.");
    process.exit(1);
  }

  const written = [];
  for (const { source, destination } of planned) {
    const contents = rewriteCrossLinks(readFileSync(source, "utf8"), target);
    if (existsSync(destination) && readFileSync(destination, "utf8") === contents) continue;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
    written.push(relative(process.cwd(), destination));
  }

  if (written.length === 0) {
    console.log("Already up to date.");
    process.exit(0);
  }
  for (const path of written) console.log(`Installed ${path}`);
  console.log("Your coding agent will pick it up on its next run.");
}

main();
