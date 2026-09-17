const UINT32_RANGE = 0x1_0000_0000;

export function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function nextMulberry32(state) {
  const nextState = (state + 0x6d2b79f5) >>> 0;
  let value = nextState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return {
    state: nextState,
    value: ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE,
  };
}

export function createArrivalRandomState(normalizedGameCode, config) {
  return fnv1a32(`${config.seedVersion}|${config.seedSalt}|${normalizedGameCode}`);
}

export function nextExponentialArrival(randomState, ratePerMinute, precision) {
  const random = nextMulberry32(randomState);
  const interval = -Math.log1p(-random.value) / ratePerMinute;
  return {
    randomState: random.state,
    interval: Math.round(interval * precision) / precision,
  };
}

// Patient-keyed draws do not depend on staffing, service order, or arrival PRNG state.
export function serviceMinutes(gameCode, patientId, activityId, config) {
  const activity = config.activities[activityId];
  if (activity.serviceDistribution !== "EXPONENTIAL") {
    return activity.processingMinutes;
  }
  const seed = fnv1a32(`comm204-service-v1|${config.seedSalt}|${gameCode}|${patientId}|${activityId}`);
  const uniform = (nextMulberry32(seed).value * UINT32_RANGE + 0.5) / UINT32_RANGE;
  return Math.max(0.000001,
    Math.round(-Math.log1p(-uniform) * activity.processingMinutes * 1_000_000) / 1_000_000);
}
