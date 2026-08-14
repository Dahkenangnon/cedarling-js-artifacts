import { createRequire } from "node:module";

import { createCedarling } from "@janssenproject/cedarling";

const policyStore = {
  cedar_version: "v4.0.0",
  policy_stores: {
    snapshot: {
      cedar_version: "v4.0.0",
      name: "Snapshot verification",
      policies: {
        allow: {
          description: "allow the verification request",
          creation_date: "2026-08-14T00:00:00Z",
          policy_content: {
            encoding: "none",
            content_type: "cedar",
            body: 'permit(principal, action == Snapshot::Action::"Read", resource);'
          }
        }
      },
      schema: {
        encoding: "none",
        content_type: "cedar",
        body: [
          "namespace Snapshot {",
          "entity User;",
          "entity Document;",
          'action "Read" appliesTo { principal: [User], resource: [Document], context: {} };',
          "}"
        ].join("\n")
      }
    }
  }
};

async function exercise(create, moduleKind) {
  const created = await create({
    applicationName: `artifact-${moduleKind}`,
    policyStore: { type: "inline", document: policyStore }
  });
  if (!created.ok) {
    throw new Error(`${moduleKind} initialization failed: ${created.error.code}`);
  }

  try {
    const result = await created.value.authorizeUnsigned({
      principal: { type: "Snapshot::User", id: "alice" },
      action: 'Snapshot::Action::"Read"',
      resource: { type: "Snapshot::Document", id: "release-notes" }
    });
    if (!result.ok) {
      throw new Error(`${moduleKind} authorization failed: ${result.error.code}`);
    }
    if (result.value.decision !== true) {
      throw new Error(`${moduleKind} authorization was denied`);
    }
  } finally {
    const closed = await created.value.shutDown();
    if (!closed.ok) {
      throw new Error(`${moduleKind} shutdown failed: ${closed.error.code}`);
    }
  }
}

await exercise(createCedarling, "esm");

const require = createRequire(import.meta.url);
const commonJsSdk = require("@janssenproject/cedarling");
if (typeof commonJsSdk.createCedarling !== "function") {
  throw new Error("CommonJS export does not expose createCedarling");
}
await exercise(commonJsSdk.createCedarling, "commonjs");

console.log("Cedarling artifact consumer verification passed");

