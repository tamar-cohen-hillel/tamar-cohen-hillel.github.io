import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import {
  ACTIVITY_IDS,
  createSimulation,
  simulatePeriod,
} from "../src/simulation/engine.js";
import {
  BACKUP_ENVELOPE_VERSION,
  BACKUP_PAYLOAD_VERSION,
  backupFilename,
  createDecisionBackupPayload,
  decryptDecisionBackup,
  encryptDecisionBackup,
} from "../src/backup/game-backup.js";

const ALLOCATION = Object.freeze({
  W1: ACTIVITY_IDS.ROUTINE,
  W2: ACTIVITY_IDS.ASSESSMENT,
  W3: ACTIVITY_IDS.ROUTINE,
  W4: ACTIVITY_IDS.DIAGNOSTICS,
  W5: ACTIVITY_IDS.REVIEW,
  W6: ACTIVITY_IDS.ASSESSMENT,
});

function bytesToBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

async function testKeys() {
  const pair = await webcrypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const spki = new Uint8Array(await webcrypto.subtle.exportKey("spki", pair.publicKey));
  const fingerprint = Buffer.from(await webcrypto.subtle.digest("SHA-256", spki)).toString("hex");
  return {
    publicKey: {
      algorithm: "RSA-OAEP-2048-SHA-256-TEST",
      fingerprintSha256: fingerprint,
      spkiPem: `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(spki)}\n-----END PUBLIC KEY-----`,
    },
    privateKey: pair.privateKey,
  };
}

function sessionWithPeriods(count = 2) {
  let simulationState = createSimulation("backup-game");
  const periodTransactions = [];
  for (let period = 1; period <= count; period += 1) {
    const simulated = simulatePeriod(simulationState, ALLOCATION);
    periodTransactions.push({
      uuid: `period-${period}`,
      period,
      endingStateChecksum: simulated.state.stateChecksum,
      formRecord: {
        localDiagnosticTime: `2026-09-04T12:0${period}:00.000Z`,
        payloadChecksum: `checksum-${period}`,
        payload: { allocation: ALLOCATION },
      },
    });
    simulationState = simulated.state;
  }
  return {
    gameCode: { display: "backup-game", normalized: "BACKUP-GAME" },
    teamCode: { display: "Team 7", normalized: "TEAM 7" },
    simulationState,
    periodTransactions,
  };
}

function collectKeys(value, found = new Set()) {
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    collectKeys(child, found);
  }
  return found;
}

test("decision-only payload includes allocations and audit identity but no outcomes", () => {
  const payload = createDecisionBackupPayload(sessionWithPeriods(), {
    teamEndUuid: "team-end-1",
    createdAt: "2026-09-04T12:10:00.000Z",
  });
  assert.equal(payload.backupPayloadVersion, BACKUP_PAYLOAD_VERSION);
  assert.equal(payload.completedPeriods, 2);
  assert.deepEqual(payload.periods[0].appliedAllocation, ALLOCATION);
  const keys = collectKeys(payload);
  for (const prohibited of [
    "arrivals",
    "events",
    "patients",
    "queues",
    "waiting",
    "utilization",
    "completions",
    "flowTime",
    "periodResults",
    "simulationState",
  ]) {
    assert.equal(keys.has(prohibited), false, `Backup exposed ${prohibited}`);
  }
});

test("hybrid envelope decrypts only with its private key and is opaque", async () => {
  const keys = await testKeys();
  const payload = createDecisionBackupPayload(sessionWithPeriods(), {
    teamEndUuid: "team-end-secret",
    createdAt: "2026-09-04T12:10:00.000Z",
  });
  const encrypted = await encryptDecisionBackup(payload, {
    cryptoImpl: webcrypto,
    publicKey: keys.publicKey,
  });
  assert.equal(encrypted.envelope.envelopeVersion, BACKUP_ENVELOPE_VERSION);
  assert.match(encrypted.checksumSha256, /^[0-9a-f]{64}$/);
  assert.equal(encrypted.fileText.includes("BACKUP-GAME"), false);
  assert.equal(encrypted.fileText.includes("ROUTINE"), false);
  assert.deepEqual(
    await decryptDecisionBackup(encrypted.fileText, keys.privateKey, { cryptoImpl: webcrypto }),
    payload,
  );
});

test("authenticated encryption rejects ciphertext tampering", async () => {
  const keys = await testKeys();
  const encrypted = await encryptDecisionBackup({ secret: "allocation" }, {
    cryptoImpl: webcrypto,
    publicKey: keys.publicKey,
  });
  const envelope = JSON.parse(encrypted.fileText);
  const ciphertext = Buffer.from(envelope.ciphertextBase64, "base64");
  ciphertext[0] ^= 1;
  envelope.ciphertextBase64 = ciphertext.toString("base64");
  await assert.rejects(
    decryptDecisionBackup(JSON.stringify(envelope), keys.privateKey, { cryptoImpl: webcrypto }),
  );
});

test("each encryption uses fresh randomness and filename is opaque", async () => {
  const keys = await testKeys();
  const first = await encryptDecisionBackup({ decisions: [ALLOCATION] }, {
    cryptoImpl: webcrypto,
    publicKey: keys.publicKey,
  });
  const second = await encryptDecisionBackup({ decisions: [ALLOCATION] }, {
    cryptoImpl: webcrypto,
    publicKey: keys.publicKey,
  });
  assert.notEqual(first.fileText, second.fileText);
  assert.equal(backupFilename("uuid-1"), "comm204-game-verification-uuid-1.gamebackup");
});
