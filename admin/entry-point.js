import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Was this module the thing the process was asked to run?
 *
 * The server only binds a port when it was, so that tests can import it and
 * listen on an ephemeral port of their own.
 *
 * `process.argv[1]` is the obvious way to ask and it is not sufficient: a
 * process manager may load the script from a wrapper of its own, and then
 * argv[1] is the wrapper. pm2's fork mode does exactly that. The failure is
 * quiet and unusually convincing -- pm2 reports the process as online, it sits
 * at a healthy memory figure, it opens no database connection and listens on
 * nothing, and there is not a line in the log to say so.
 *
 * pm2 records the real script in `pm_exec_path`, so that is asked first.
 */
export function isEntryPoint(moduleUrl, env = process.env, argv = process.argv) {
  const entry = env.pm_exec_path || argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(moduleUrl);
}
