import { handleInvitation } from "./_lib/send-invitation.js";

/**
 * Vercel serverless entry point.
 *
 * Kept alongside server.js so the site can run on Vercel or on our own
 * host without the two drifting apart — both delegate to the same
 * handleInvitation().
 */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body;
  const { status, body: payload } = await handleInvitation(body);
  return res.status(status).json(payload);
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
