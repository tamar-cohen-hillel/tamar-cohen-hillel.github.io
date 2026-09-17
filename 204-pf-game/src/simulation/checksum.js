import { fnv1a32 } from "./random.js";

export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
  return `{${entries.join(",")}}`;
}

export function checksum(value) {
  return fnv1a32(canonicalStringify(value)).toString(16).padStart(8, "0");
}
