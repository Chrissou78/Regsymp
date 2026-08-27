import { configStatus } from "./_lib/send-invitation.js";

/**
 * Vercel counterpart to the /api/health route in server.js, so both hosts
 * can be checked the same way.
 */
export default function handler(req, res) {
  return res.status(200).json({ ok: true, host: "vercel", ...configStatus() });
}
