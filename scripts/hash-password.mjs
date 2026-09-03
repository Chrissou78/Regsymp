#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hashPassword } from "../admin/password.js";

/**
 * Generate an ADMIN_USERS entry. The password is never written to disk,
 * never echoed back, and never stored anywhere but the hash you paste
 * into the environment.
 */
const rl = createInterface({ input: stdin, output: stdout });

const email = (await rl.question("Email: ")).trim().toLowerCase();
if (!email.includes("@")) {
  console.error("That does not look like an email address.");
  process.exit(1);
}

const password = await rl.question("Password: ");
if (password.length < 12) {
  console.error("Use at least 12 characters. This guards write access to the site.");
  process.exit(1);
}

rl.close();

const hash = await hashPassword(password);

console.log("\nAdd this to ADMIN_USERS (comma-separate multiple accounts):\n");
console.log(`${email}:${hash}\n`);
console.log("Do not wrap the value in quotes.");
