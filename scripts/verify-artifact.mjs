import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = path.join(repoRoot, "artifacts");
const verifyRoot = path.join(repoRoot, "work", "verify");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(file) {
  return sha256(await readFile(file));
}

const versions = (await readdir(artifactsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const requestedVersion = process.argv[2];
const version = requestedVersion ?? versions.at(-1);
if (!version || !versions.includes(version)) {
  throw new Error(`Artifact version not found: ${requestedVersion ?? "latest"}`);
}

const artifactRoot = path.join(artifactsRoot, version);
const provenance = JSON.parse(
  await readFile(path.join(artifactRoot, "provenance.json"), "utf8")
);
if (provenance.version !== version) {
  throw new Error("Artifact directory and provenance versions differ");
}
const tarball = path.join(artifactRoot, provenance.artifact.file);
if ((await sha256File(tarball)) !== provenance.artifact.sha256) {
  throw new Error("Artifact checksum does not match provenance");
}

const checksumLines = (await readFile(path.join(artifactRoot, "SHA256SUMS"), "utf8"))
  .trim()
  .split("\n");
for (const line of checksumLines) {
  const [expected, file] = line.split(/\s{2}/);
  if (!expected || !file) {
    throw new Error(`Malformed checksum line: ${line}`);
  }
  if ((await sha256File(path.join(artifactRoot, file))) !== expected) {
    throw new Error(`Checksum mismatch: ${file}`);
  }
}

const entries = run("tar", ["-tzf", tarball], { capture: true })
  .trim()
  .split("\n");
const requiredPatterns = [
  /^package\/package\.json$/,
  /^package\/dist\/index\.js$/,
  /^package\/dist\/cjs\/index\.cjs$/,
  /^package\/node_modules\/@janssenproject\/cedarling_wasm\/package\.json$/,
  /^package\/node_modules\/@janssenproject\/cedarling_wasm\/cedarling_wasm_bg\.wasm$/
];
for (const pattern of requiredPatterns) {
  if (!entries.some((entry) => pattern.test(entry))) {
    throw new Error(`Tarball is missing ${pattern}`);
  }
}
const forbidden = entries.filter((entry) =>
  /(^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$))|\.(?:key|pem|p12|pfx)$/i.test(entry)
);
if (forbidden.length > 0) {
  throw new Error(`Tarball contains forbidden paths: ${forbidden.join(", ")}`);
}

const resolvedVerifyRoot = path.resolve(verifyRoot);
if (resolvedVerifyRoot !== path.resolve(repoRoot, "work", "verify")) {
  throw new Error(`Refusing to clear unexpected verification path: ${resolvedVerifyRoot}`);
}
await rm(resolvedVerifyRoot, { recursive: true, force: true });
await mkdir(resolvedVerifyRoot, { recursive: true });
await writeFile(
  path.join(resolvedVerifyRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "cedarling-artifact-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: {
        "@janssenproject/cedarling": `file:${tarball}`
      }
    },
    null,
    2
  )}\n`
);
await cp(
  path.join(repoRoot, "fixtures", "consumer.mjs"),
  path.join(resolvedVerifyRoot, "consumer.mjs")
);
run(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--package-lock=false",
    "--no-audit",
    "--no-fund"
  ],
  { cwd: resolvedVerifyRoot }
);
run("node", ["consumer.mjs"], { cwd: resolvedVerifyRoot });

console.log(`Verified artifacts/${version}`);
