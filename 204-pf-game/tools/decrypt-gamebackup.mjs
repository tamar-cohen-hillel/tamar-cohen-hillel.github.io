import { readFile, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

import { decryptDecisionBackup } from "../src/backup/game-backup.js";

const [privateKeyPath, backupPath, outputPath] = process.argv.slice(2);
if (!privateKeyPath || !backupPath || !outputPath) {
  throw new Error(
    "Usage: node tools/decrypt-gamebackup.mjs <private-key.pem> <input.gamebackup> <output.json>",
  );
}

const privatePem = await readFile(privateKeyPath, "utf8");
const privateDer = Buffer.from(
  privatePem.replace(/-----[^-]+-----|\s/g, ""),
  "base64",
);
const privateKey = await webcrypto.subtle.importKey(
  "pkcs8",
  privateDer,
  { name: "RSA-OAEP", hash: "SHA-256" },
  false,
  ["decrypt"],
);
const fileText = await readFile(backupPath, "utf8");
const payload = await decryptDecisionBackup(fileText, privateKey, {
  cryptoImpl: webcrypto,
});
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
console.log(`Decrypted backup written to ${outputPath}`);

