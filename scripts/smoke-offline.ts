import { strict as assert } from "node:assert";
import { createContactDepartureSession } from "../src/session.js";
import { runPing } from "../src/tools/ping.js";

const updates: unknown[] = [];
const result = await runPing({ message: "offline-ok" }, (partial) => updates.push(partial));

assert.equal(result.details.ok, true);
assert.equal(result.details.echo, "offline-ok");
assert.equal(updates.length, 1);

const { session } = await createContactDepartureSession();
try {
  const activeTools = session.getActiveToolNames().sort();
  const configuredTools = session.getAllTools().map((tool) => tool.name).sort();

  assert.deepEqual(activeTools, ["ping"]);
  for (const blockedTool of ["bash", "read", "write", "edit", "grep", "find", "ls"]) {
    assert.equal(activeTools.includes(blockedTool), false, `${blockedTool} must not be active`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        activeTools,
        configuredTools,
        ping: result.details,
      },
      null,
      2,
    ),
  );
} finally {
  session.dispose();
}
