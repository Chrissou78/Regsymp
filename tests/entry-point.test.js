import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isEntryPoint } from "../admin/entry-point.js";

/**
 * The server binds a port only when it was the thing the process was asked to
 * run, so that tests can import it and listen on a port of their own.
 *
 * Asking argv[1] is the obvious way and it is not enough. Under pm2's fork
 * mode the script is loaded from a wrapper, argv[1] is the wrapper, and the
 * server quietly never starts: pm2 reports it online, it sits at a healthy
 * memory figure, it opens no database connection, it listens on nothing, and
 * it writes not one line to the log. Four minutes of staring at "online"
 * before anybody thinks to check.
 */

const SERVER = path.resolve("server.js");
const AS_URL = pathToFileURL(SERVER).href;

test("run directly, it is the entry point", () => {
  assert.equal(isEntryPoint(AS_URL, {}, ["node", SERVER]), true);
});

test("a relative path is still the same file", () => {
  assert.equal(isEntryPoint(AS_URL, {}, ["node", "server.js"]), true);
});

test("imported by a test, it is not", () => {
  assert.equal(isEntryPoint(AS_URL, {}, ["node", path.resolve("tests/site.test.js")]), false);
});

test("under a process manager, the wrapper is not mistaken for the script", () => {
  // The bug: pm2 puts its own loader in argv[1] and the real script in
  // pm_exec_path. Reading only argv[1] made the guard false and the server
  // never listened.
  const pm2 = {
    pm_exec_path: SERVER,
    pm_id: "9"
  };
  const wrapper = ["node", "/usr/lib/node_modules/pm2/lib/ProcessContainerFork.js"];

  assert.equal(isEntryPoint(AS_URL, pm2, wrapper), true, "the server would not have started");
});

test("a process manager running something else does not start this", () => {
  const pm2 = { pm_exec_path: path.resolve("scripts/hash-password.mjs") };
  assert.equal(isEntryPoint(AS_URL, pm2, ["node", "/pm2/ProcessContainerFork.js"]), false);
});

test("nothing to go on means no", () => {
  assert.equal(isEntryPoint(AS_URL, {}, ["node"]), false);
  assert.equal(isEntryPoint(AS_URL, {}, []), false);
});
