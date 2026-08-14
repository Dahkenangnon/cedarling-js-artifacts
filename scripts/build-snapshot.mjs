import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WASM_PACK_VERSION = "0.14.0";
const WASM_PACK_ARCHIVE = `wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl.tar.gz`;
const WASM_PACK_URL = `https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${WASM_PACK_ARCHIVE}`;
const WASM_PACK_SHA256 =
  "278a8d668085821f4d1a637bd864f1713f872b0ae3a118c77562a308c0abfe8d";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jansRoot = path.resolve(repoRoot, "../../../../jans");
const workRoot = path.join(repoRoot, "work");
const sourceRoot = path.join(workRoot, "source");
const stageRoot = path.join(workRoot, "stage", "package");
const toolsRoot = path.join(repoRoot, ".tools");
const archivePath = path.join(workRoot, "jans-head.tar");

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.encoding ?? "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 256 * 1024 * 1024,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
}

function capture(command, args, cwd = repoRoot) {
  return run(command, args, { cwd, capture: true }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(file) {
  return sha256(await readFile(file));
}

function splitNull(value) {
  return value.split("\0").filter(Boolean);
}

function assertSafeRelative(relativePath) {
  if (
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Unsafe source path: ${relativePath}`);
  }
}

function looksSensitive(relativePath) {
  return /(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519|credentials)(\/|$)|\.(?:key|pem|p12|pfx)$/i.test(
    relativePath
  );
}

async function resetBuildDirectories() {
  const resolvedWork = path.resolve(workRoot);
  if (resolvedWork !== path.resolve(repoRoot, "work")) {
    throw new Error(`Refusing to clear unexpected work path: ${resolvedWork}`);
  }
  await rm(resolvedWork, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(stageRoot, { recursive: true });
  await mkdir(toolsRoot, { recursive: true });
}

async function exportWorkingTree() {
  run("git", ["archive", "--format=tar", "--output", archivePath, "HEAD"], {
    cwd: jansRoot
  });
  run("tar", ["-xf", archivePath, "-C", sourceRoot]);
  await rm(archivePath);

  const changed = splitNull(
    run("git", ["diff", "--name-only", "-z", "HEAD", "--", "."], {
      cwd: jansRoot,
      capture: true
    })
  );
  const untracked = splitNull(
    run(
      "git",
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "jans-cedarling"
      ],
      { cwd: jansRoot, capture: true }
    )
  );

  for (const relativePath of [...changed, ...untracked]) {
    assertSafeRelative(relativePath);
    if (looksSensitive(relativePath)) {
      throw new Error(`Refusing to copy secret-like path: ${relativePath}`);
    }
    const source = path.join(jansRoot, relativePath);
    const destination = path.join(sourceRoot, relativePath);
    try {
      const sourceStat = await stat(source);
      await mkdir(path.dirname(destination), { recursive: true });
      if (sourceStat.isDirectory()) {
        await cp(source, destination, { recursive: true, dereference: false });
      } else {
        await copyFile(source, destination);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await rm(destination, { recursive: true, force: true });
    }
  }

  return { changed, untracked };
}

async function installWasmPack() {
  const installRoot = path.join(toolsRoot, `wasm-pack-${WASM_PACK_VERSION}`);
  const binary = path.join(installRoot, "wasm-pack");
  try {
    if ((await sha256File(binary)).length === 64) {
      return binary;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const downloadRoot = path.join(toolsRoot, "downloads");
  const downloadPath = path.join(downloadRoot, WASM_PACK_ARCHIVE);
  await mkdir(downloadRoot, { recursive: true });
  const response = await fetch(WASM_PACK_URL);
  if (!response.ok) {
    throw new Error(`Unable to download wasm-pack: HTTP ${response.status}`);
  }
  await writeFile(downloadPath, Buffer.from(await response.arrayBuffer()));
  const actualChecksum = await sha256File(downloadPath);
  if (actualChecksum !== WASM_PACK_SHA256) {
    throw new Error(
      `wasm-pack checksum mismatch: expected ${WASM_PACK_SHA256}, received ${actualChecksum}`
    );
  }

  const extractRoot = path.join(toolsRoot, `extract-${WASM_PACK_VERSION}`);
  await rm(extractRoot, { recursive: true, force: true });
  await mkdir(extractRoot, { recursive: true });
  run("tar", ["-xzf", downloadPath, "-C", extractRoot]);
  const [directory] = await readdir(extractRoot);
  if (!directory) {
    throw new Error("wasm-pack archive was empty");
  }
  const extractedBinary = path.join(extractRoot, directory, "wasm-pack");
  await mkdir(installRoot, { recursive: true });
  await copyFile(extractedBinary, binary);
  await chmod(binary, 0o755);
  await rm(extractRoot, { recursive: true, force: true });
  return binary;
}

async function stagePackage(version) {
  const sdkRoot = path.join(
    sourceRoot,
    "jans-cedarling",
    "bindings",
    "cedarling_js"
  );
  const wasmRoot = path.join(
    sourceRoot,
    "jans-cedarling",
    "bindings",
    "cedarling_wasm",
    "pkg"
  );
  const sdkManifest = JSON.parse(await readFile(path.join(sdkRoot, "package.json"), "utf8"));
  const wasmManifest = JSON.parse(await readFile(path.join(wasmRoot, "package.json"), "utf8"));

  await cp(path.join(sdkRoot, "dist"), path.join(stageRoot, "dist"), {
    recursive: true
  });
  for (const file of ["README.md", "LICENSE"]) {
    const candidates = [path.join(sdkRoot, file), path.join(sourceRoot, file)];
    for (const candidate of candidates) {
      try {
        await copyFile(candidate, path.join(stageRoot, file));
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  const bundledWasmRoot = path.join(
    stageRoot,
    "node_modules",
    "@janssenproject",
    "cedarling_wasm"
  );
  await mkdir(path.dirname(bundledWasmRoot), { recursive: true });
  await cp(wasmRoot, bundledWasmRoot, { recursive: true });

  const stagedWasmManifest = {
    ...wasmManifest,
    version,
    private: undefined
  };
  await writeFile(
    path.join(bundledWasmRoot, "package.json"),
    `${JSON.stringify(stagedWasmManifest, null, 2)}\n`
  );

  const stagedSdkManifest = {
    ...sdkManifest,
    version,
    private: undefined,
    scripts: undefined,
    devDependencies: undefined,
    dependencies: { "@janssenproject/cedarling_wasm": version },
    bundleDependencies: ["@janssenproject/cedarling_wasm"],
    publishConfig: { access: "public" }
  };
  await writeFile(
    path.join(stageRoot, "package.json"),
    `${JSON.stringify(stagedSdkManifest, null, 2)}\n`
  );
}

async function writeArtifactMetadata({
  artifactRoot,
  tarball,
  version,
  baseCommit,
  branch,
  diffHash,
  changed,
  untracked,
  sourceHash,
  wasmPackBinary
}) {
  const untrackedFiles = [];
  for (const relativePath of untracked) {
    const source = path.join(jansRoot, relativePath);
    const sourceStat = await stat(source);
    if (sourceStat.isFile()) {
      untrackedFiles.push({ path: relativePath, sha256: await sha256File(source) });
    }
  }

  const provenance = {
    schemaVersion: 1,
    package: "@janssenproject/cedarling",
    version,
    generatedAt: new Date().toISOString(),
    source: {
      repository: "https://github.com/JanssenProject/jans.git",
      branch,
      baseCommit,
      dirty: changed.length > 0 || untracked.length > 0,
      trackedChangePaths: changed,
      diffSha256: diffHash,
      untrackedFiles,
      snapshotSha256: sourceHash
    },
    tools: {
      node: process.version,
      npm: capture("npm", ["--version"]),
      rustc: capture("rustc", ["--version"]),
      cargo: capture("cargo", ["--version"]),
      wasmPack: capture(wasmPackBinary, ["--version"])
    },
    build: {
      wasmTarget: "web",
      wasmRelease: true,
      cargoLocked: true,
      bundledPackages: ["@janssenproject/cedarling_wasm"]
    },
    artifact: {
      file: path.basename(tarball),
      sha256: await sha256File(tarball)
    }
  };
  const provenancePath = path.join(artifactRoot, "provenance.json");
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `cedarling-js-${version}`,
    documentNamespace: `https://github.com/Dahkenangnon/cedarling-js-artifacts/spdx/${version}/${sourceHash}`,
    creationInfo: {
      created: provenance.generatedAt,
      creators: ["Tool: cedarling-js-artifacts/build-snapshot.mjs"]
    },
    packages: [
      {
        SPDXID: "SPDXRef-Package-Cedarling",
        name: "@janssenproject/cedarling",
        versionInfo: version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "Apache-2.0",
        licenseDeclared: "Apache-2.0",
        supplier: "Organization: Janssen Project"
      },
      {
        SPDXID: "SPDXRef-Package-Cedarling-Wasm",
        name: "@janssenproject/cedarling_wasm",
        versionInfo: version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "Apache-2.0",
        licenseDeclared: "Apache-2.0",
        supplier: "Organization: Janssen Project"
      }
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Package-Cedarling"
      },
      {
        spdxElementId: "SPDXRef-Package-Cedarling",
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: "SPDXRef-Package-Cedarling-Wasm"
      }
    ]
  };
  const sbomPath = path.join(artifactRoot, "sbom.spdx.json");
  await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

  const checksumFiles = [tarball, provenancePath, sbomPath];
  const checksumLines = [];
  for (const file of checksumFiles) {
    checksumLines.push(`${await sha256File(file)}  ${path.basename(file)}`);
  }
  await writeFile(path.join(artifactRoot, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
}

await stat(path.join(jansRoot, ".git"));
await resetBuildDirectories();

const baseCommit = capture("git", ["rev-parse", "HEAD"], jansRoot);
const branch = capture("git", ["branch", "--show-current"], jansRoot) || "detached";
const diff = run("git", ["diff", "--binary", "HEAD", "--", "."], {
  cwd: jansRoot,
  capture: true
});
const diffHash = sha256(diff);
const { changed, untracked } = await exportWorkingTree();
const untrackedHashes = [];
for (const relativePath of untracked) {
  const candidate = path.join(jansRoot, relativePath);
  if ((await stat(candidate)).isFile()) {
    untrackedHashes.push(`${relativePath}\0${await sha256File(candidate)}`);
  }
}
const sourceHash = sha256(
  [baseCommit, diffHash, ...untrackedHashes.sort()].join("\0")
);
const version = `0.0.0-snapshot.${baseCommit.slice(0, 12)}.${sourceHash.slice(0, 12)}`;

const wasmPackBinary = await installWasmPack();
const wasmRoot = path.join(
  sourceRoot,
  "jans-cedarling",
  "bindings",
  "cedarling_wasm"
);
const sdkRoot = path.join(
  sourceRoot,
  "jans-cedarling",
  "bindings",
  "cedarling_js"
);

run(
  wasmPackBinary,
  ["build", "--release", "--locked", "--target", "web", "--scope", "janssenproject"],
  { cwd: wasmRoot }
);
run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: sdkRoot });
run("npm", ["run", "build"], { cwd: sdkRoot });
run("npm", ["run", "typecheck"], { cwd: sdkRoot });

await stagePackage(version);
const artifactRoot = path.join(repoRoot, "artifacts", version);
await mkdir(artifactRoot, { recursive: true });
const packResult = JSON.parse(
  run("npm", ["pack", "--json", "--pack-destination", artifactRoot], {
    cwd: stageRoot,
    capture: true
  })
);
const tarball = path.join(artifactRoot, packResult[0].filename);
await writeArtifactMetadata({
  artifactRoot,
  tarball,
  version,
  baseCommit,
  branch,
  diffHash,
  changed,
  untracked,
  sourceHash,
  wasmPackBinary
});
await copyFile(tarball, path.join(repoRoot, "cedarling.tgz"));

console.log(`Created ${path.relative(repoRoot, tarball)}`);
