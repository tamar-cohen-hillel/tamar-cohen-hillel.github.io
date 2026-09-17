# Encrypted game-verification backup

The student download is a hybrid-encrypted `.gamebackup` envelope. A random AES-256-GCM key encrypts and authenticates the canonical decision-only payload; the deployed RSA-OAEP-3072/SHA-256 public key encrypts that AES key. The exact envelope text has a SHA-256 checksum recorded in `TEAM_END`.

The envelope exposes only format/algorithm identifiers, the public-key fingerprint, IV, encrypted key, and ciphertext. It contains no readable game identity, decisions, patient data, results, or statistics.

The matching private key is not stored anywhere in this repository. Keep it outside the project and back it up securely; a lost private key cannot be recovered from the public key.

To decrypt a file offline:

```text
node tools/decrypt-gamebackup.mjs <private-key.pem> <input.gamebackup> <output.json>
```

The command refuses to overwrite an existing output file.
