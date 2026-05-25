import { strict as assert } from "node:assert";
import {
  loadRemoteRuntimeConfig,
  remoteRuntimeMode,
  shouldDispatchPx4ReplayRemotely,
} from "../src/domain/remote-runtime.js";

const originalRemote = process.env.CONTACT_DEPARTURE_REMOTE_RUNTIME;
const originalSsh = process.env.CONTACT_DEPARTURE_REMOTE_SSH;
const originalRepo = process.env.CONTACT_DEPARTURE_REMOTE_REPO;

function restoreEnv(): void {
  if (originalRemote === undefined) {
    delete process.env.CONTACT_DEPARTURE_REMOTE_RUNTIME;
  } else {
    process.env.CONTACT_DEPARTURE_REMOTE_RUNTIME = originalRemote;
  }
  if (originalSsh === undefined) {
    delete process.env.CONTACT_DEPARTURE_REMOTE_SSH;
  } else {
    process.env.CONTACT_DEPARTURE_REMOTE_SSH = originalSsh;
  }
  if (originalRepo === undefined) {
    delete process.env.CONTACT_DEPARTURE_REMOTE_REPO;
  } else {
    process.env.CONTACT_DEPARTURE_REMOTE_REPO = originalRepo;
  }
}

try {
  delete process.env.CONTACT_DEPARTURE_REMOTE_RUNTIME;
  delete process.env.CONTACT_DEPARTURE_REMOTE_SSH;
  delete process.env.CONTACT_DEPARTURE_REMOTE_REPO;
  assert.equal(remoteRuntimeMode(), "off");
  assert.equal(shouldDispatchPx4ReplayRemotely(), false);
  assert.equal(loadRemoteRuntimeConfig(), null);

  process.env.CONTACT_DEPARTURE_REMOTE_RUNTIME = "stub";
  assert.equal(remoteRuntimeMode(), "stub");
  assert.equal(shouldDispatchPx4ReplayRemotely(), true);
  const stubConfig = loadRemoteRuntimeConfig();
  assert.ok(stubConfig);
  assert.equal(stubConfig?.sshTarget, "stub@remote-runtime.local");

  process.env.CONTACT_DEPARTURE_REMOTE_RUNTIME = "1";
  process.env.CONTACT_DEPARTURE_REMOTE_SSH = "reviewer@pod.example";
  process.env.CONTACT_DEPARTURE_REMOTE_REPO = "/workspace/Airbus-FYI";
  assert.equal(remoteRuntimeMode(), "ssh");
  const sshConfig = loadRemoteRuntimeConfig();
  assert.ok(sshConfig);
  assert.equal(sshConfig?.sshTarget, "reviewer@pod.example");
  assert.equal(sshConfig?.remoteRepo, "/workspace/Airbus-FYI");
  assert.ok(sshConfig?.sshOptions.includes("BatchMode=yes"));

  process.env.CONTACT_DEPARTURE_REMOTE_RUNTIME = "stub";
  const { launchEvidenceJob, inspectJob } = await import("../src/domain/jobs.js");
  const launch = await launchEvidenceJob({
    case_id: "mavlink-battery-status-runtime-replay",
    test_card_id: "px4-runtime-replay",
    target_commit: "mavlink-battery-status-bounds-post",
    budget_profile: "smoke-fast",
  });
  assert.equal(launch.runner?.execution_host, "remote-stub");
  assert.match(launch.runner?.process?.entrypoint ?? "", /remote-px4-runtime-bridge/);

  const deadline = Date.now() + 60_000;
  let terminal = false;
  while (Date.now() < deadline) {
    const detail = await inspectJob({ job_id: launch.job_id });
    if (detail.state === "succeeded" || detail.state === "failed" || detail.state === "cancelled") {
      terminal = true;
      assert.ok(detail.runner?.execution_host === "remote-stub");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(terminal, true, "stub remote runtime job must reach a terminal state");

  process.env.CONTACT_DEPARTURE_REMOTE_RUNTIME = "1";
  delete process.env.CONTACT_DEPARTURE_REMOTE_SSH;
  delete process.env.CONTACT_DEPARTURE_REMOTE_REPO;
  assert.equal(loadRemoteRuntimeConfig(), null);
} finally {
  restoreEnv();
}

console.log("smoke:remote-runtime passed");
