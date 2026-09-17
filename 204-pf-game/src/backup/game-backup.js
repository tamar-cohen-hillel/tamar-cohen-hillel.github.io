import { canonicalStringify } from "../simulation/checksum.js";
import { APPLICATION_VERSION } from "../submission/google-form.js";
import { BACKUP_PUBLIC_KEY } from "./public-key.js";

export const BACKUP_PAYLOAD_VERSION = "comm204-decision-backup-v1";
export const BACKUP_ENVELOPE_VERSION = "comm204-gamebackup-v1";

const encoder = new TextEncoder();

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pemToDer(pem) {
  return base64ToBytes(pem.replace(/-----[^-]+-----|\s/g, ""));
}

function hex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function createDecisionBackupPayload(session, {
  teamEndUuid,
  createdAt = new Date().toISOString(),
  optionalNotes = null,
} = {}) {
  return {
    backupPayloadVersion: BACKUP_PAYLOAD_VERSION,
    applicationVersion: APPLICATION_VERSION,
    createdAt,
    gameCode: structuredClone(session.gameCode),
    teamCode: structuredClone(session.teamCode),
    completedPeriods: session.simulationState.completedPeriods,
    teamEndUuid,
    replayConfiguration: {
      simulationSchemaVersion: session.simulationState.schemaVersion,
      configurationVersion: session.simulationState.configurationVersion,
      seedVersion: session.simulationState.seedVersion,
    },
    periods: session.periodTransactions.map((transaction) => ({
      period: transaction.period,
      appliedAllocation: structuredClone(
        transaction.formRecord?.payload?.allocation ?? transaction.formRecord?.allocation,
      ),
      localDiagnosticTime: transaction.formRecord?.localDiagnosticTime ?? null,
      transactionUuid: transaction.uuid,
      payloadChecksum: transaction.formRecord?.payloadChecksum ?? null,
      endingStateChecksum: transaction.endingStateChecksum,
    })),
    optionalNotes,
  };
}

export async function encryptDecisionBackup(payload, {
  cryptoImpl = globalThis.crypto,
  publicKey = BACKUP_PUBLIC_KEY,
} = {}) {
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new Error("This browser does not support the required backup encryption.");
  }
  const publicKeyDer = pemToDer(publicKey.spkiPem);
  const publicKeyDigest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", publicKeyDer));
  if (hex(publicKeyDigest) !== publicKey.fingerprintSha256) {
    throw new Error("The deployed backup public key does not match its fingerprint.");
  }
  const rsaKey = await cryptoImpl.subtle.importKey(
    "spki",
    publicKeyDer,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const aesKey = await cryptoImpl.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  );
  const rawAesKey = new Uint8Array(await cryptoImpl.subtle.exportKey("raw", aesKey));
  const encryptedKey = new Uint8Array(await cryptoImpl.subtle.encrypt(
    { name: "RSA-OAEP" },
    rsaKey,
    rawAesKey,
  ));
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const authenticatedHeader = {
    envelopeVersion: BACKUP_ENVELOPE_VERSION,
    contentAlgorithm: "AES-256-GCM",
    keyAlgorithm: publicKey.algorithm,
    publicKeyFingerprintSha256: publicKey.fingerprintSha256,
  };
  const ciphertext = new Uint8Array(await cryptoImpl.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(canonicalStringify(authenticatedHeader)),
      tagLength: 128,
    },
    aesKey,
    encoder.encode(canonicalStringify(payload)),
  ));
  const envelope = {
    ...authenticatedHeader,
    encryptedKeyBase64: bytesToBase64(encryptedKey),
    ivBase64: bytesToBase64(iv),
    ciphertextBase64: bytesToBase64(ciphertext),
  };
  const fileText = canonicalStringify(envelope);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest("SHA-256", encoder.encode(fileText)));
  return {
    fileText,
    checksumSha256: hex(digest),
    envelope,
  };
}

export async function decryptDecisionBackup(fileText, privateKey, {
  cryptoImpl = globalThis.crypto,
} = {}) {
  const envelope = JSON.parse(fileText);
  const authenticatedHeader = {
    envelopeVersion: envelope.envelopeVersion,
    contentAlgorithm: envelope.contentAlgorithm,
    keyAlgorithm: envelope.keyAlgorithm,
    publicKeyFingerprintSha256: envelope.publicKeyFingerprintSha256,
  };
  const aesBytes = await cryptoImpl.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    base64ToBytes(envelope.encryptedKeyBase64),
  );
  const aesKey = await cryptoImpl.subtle.importKey(
    "raw",
    aesBytes,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await cryptoImpl.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.ivBase64),
      additionalData: encoder.encode(canonicalStringify(authenticatedHeader)),
      tagLength: 128,
    },
    aesKey,
    base64ToBytes(envelope.ciphertextBase64),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function backupFilename(teamEndUuid) {
  return `comm204-game-verification-${teamEndUuid}.gamebackup`;
}

export function downloadEncryptedBackup(fileText, filename, documentImpl = document) {
  const blob = new Blob([fileText], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = documentImpl.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  documentImpl.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
