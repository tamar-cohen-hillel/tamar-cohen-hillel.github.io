export function normalizeCode(value, label) {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  const display = value.trim();
  if (!display) {
    throw new Error(`${label} cannot be empty.`);
  }
  return {
    display,
    normalized: display.toUpperCase(),
  };
}

export function normalizeTeamIdentity(gameCode, teamCode) {
  return {
    game: normalizeCode(gameCode, "Game code"),
    team: normalizeCode(teamCode, "Team code"),
  };
}

export function teamSessionKey(normalizedGameCode, normalizedTeamCode) {
  return JSON.stringify([normalizedGameCode, normalizedTeamCode]);
}

export function instructorSessionKey(normalizedGameCode) {
  return JSON.stringify(["INSTRUCTOR", normalizedGameCode]);
}
