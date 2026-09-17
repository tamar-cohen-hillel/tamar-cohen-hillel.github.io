import {
  instructorSessionKey,
  normalizeCode,
  normalizeTeamIdentity,
  teamSessionKey,
} from "./identity.js";
import { IndexedDbDriver, STORE_NAMES } from "./drivers.js";

export const LOCAL_RECORD_VERSION = "comm204-local-record-v1";

export const UPLOAD_STATUS = Object.freeze({
  NOT_STARTED: "NOT_STARTED",
  ATTEMPTED_UNCONFIRMED: "ATTEMPTED_UNCONFIRMED",
  RETRY_RECOMMENDED: "RETRY_RECOMMENDED",
  RETRY_ATTEMPTED_UNCONFIRMED: "RETRY_ATTEMPTED_UNCONFIRMED",
});

export const TEAM_SESSION_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  ENDED: "ENDED",
});

export const RECOVERY_ACTION = Object.freeze({
  START_NEW: "START_NEW",
  RESUME_DECISION: "RESUME_DECISION",
  REVIEW_UPLOAD_STATUS: "REVIEW_UPLOAD_STATUS",
  SHOW_FINAL: "SHOW_FINAL",
});

export const RECOVERY_WARNINGS = Object.freeze([
  "Progress is saved only in this laptop, browser, and browser profile.",
  "Do not use private or incognito browsing.",
  "Do not clear browser data, change browsers, or change laptops during the game.",
]);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requireRecord(record, message) {
  if (!record) {
    throw new Error(message);
  }
  return record;
}

function requireActiveTeamSession(session) {
  requireRecord(session, "No matching saved team session exists.");
  if (session.status !== TEAM_SESSION_STATUS.ACTIVE) {
    throw new Error("This local team session has ended and cannot be changed.");
  }
}

function requireUuid(uuid, label) {
  if (typeof uuid !== "string" || !uuid.trim()) {
    throw new Error(`${label} UUID is required.`);
  }
}

function requireUploadStatus(status) {
  if (!Object.values(UPLOAD_STATUS).includes(status)) {
    throw new Error(`Unknown upload status: ${status}`);
  }
}

function buildTeamSession({ id, identity, simulationState, allocationDraft, timestamp }) {
  return {
    id,
    localRecordVersion: LOCAL_RECORD_VERSION,
    gameCode: identity.game,
    teamCode: identity.team,
    status: TEAM_SESSION_STATUS.ACTIVE,
    simulationState: clone(simulationState),
    allocationDraft: clone(allocationDraft),
    periodTransactions: [],
    teamEnd: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildInstructorSession({ id, game, instructorState, timestamp }) {
  return {
    id,
    localRecordVersion: LOCAL_RECORD_VERSION,
    gameCode: game,
    instructorState: clone(instructorState),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export class GamePersistence {
  constructor({
    driver = new IndexedDbDriver(),
    now = () => new Date().toISOString(),
  } = {}) {
    this.driver = driver;
    this.now = now;
  }

  async findTeamSession(gameCode, teamCode) {
    const identity = normalizeTeamIdentity(gameCode, teamCode);
    return this.driver.get(
      STORE_NAMES.TEAM_SESSIONS,
      teamSessionKey(identity.game.normalized, identity.team.normalized),
    );
  }

  async getTeamRecovery(gameCode, teamCode) {
    const session = await this.findTeamSession(gameCode, teamCode);
    if (!session) {
      return { found: false, action: RECOVERY_ACTION.START_NEW, session: null };
    }
    if (session.status === TEAM_SESSION_STATUS.ENDED) {
      return { found: true, action: RECOVERY_ACTION.SHOW_FINAL, session };
    }
    const lastTransaction = session.periodTransactions.at(-1);
    if (lastTransaction && lastTransaction.uploadStatus !== UPLOAD_STATUS.ATTEMPTED_UNCONFIRMED) {
      return { found: true, action: RECOVERY_ACTION.REVIEW_UPLOAD_STATUS, session };
    }
    return { found: true, action: RECOVERY_ACTION.RESUME_DECISION, session };
  }

  async createTeamSession({ gameCode, teamCode, simulationState, allocationDraft = null }) {
    const identity = normalizeTeamIdentity(gameCode, teamCode);
    const id = teamSessionKey(identity.game.normalized, identity.team.normalized);
    if (!simulationState || typeof simulationState !== "object") {
      throw new Error("An initial simulation state is required.");
    }

    let created = false;
    const session = await this.driver.update(STORE_NAMES.TEAM_SESSIONS, id, (existing) => {
      if (existing) {
        return existing;
      }
      created = true;
      return buildTeamSession({
        id,
        identity,
        simulationState,
        allocationDraft,
        timestamp: this.now(),
      });
    });
    return { created, session };
  }

  async replaceTeamSession({ gameCode, teamCode, simulationState, allocationDraft = null }) {
    const identity = normalizeTeamIdentity(gameCode, teamCode);
    if (!simulationState || typeof simulationState !== "object") {
      throw new Error("An initial simulation state is required.");
    }
    const id = teamSessionKey(identity.game.normalized, identity.team.normalized);
    return this.driver.put(STORE_NAMES.TEAM_SESSIONS, buildTeamSession({
      id,
      identity,
      simulationState,
      allocationDraft,
      timestamp: this.now(),
    }));
  }

  async saveAllocationDraft(gameCode, teamCode, allocationDraft) {
    return this.#updateTeam(gameCode, teamCode, (session) => {
      requireActiveTeamSession(session);
      session.allocationDraft = clone(allocationDraft);
      session.updatedAt = this.now();
      return session;
    });
  }

  async commitPeriod(gameCode, teamCode, transaction) {
    requireUuid(transaction?.uuid, "Period transaction");
    requireUploadStatus(transaction?.uploadStatus);

    return this.#updateTeam(gameCode, teamCode, (session) => {
      requireActiveTeamSession(session);
      const existing = session.periodTransactions.find(({ uuid }) => uuid === transaction.uuid);
      if (existing) {
        if (existing.endingStateChecksum !== transaction.simulationState?.stateChecksum) {
          throw new Error("A period transaction UUID cannot be reused with different state.");
        }
        return session;
      }

      const previousPeriod = session.simulationState.completedPeriods;
      const committedPeriod = transaction.simulationState?.completedPeriods;
      if (committedPeriod !== previousPeriod + 1) {
        throw new Error(
          `Atomic period commit expected period ${previousPeriod + 1}, received ${committedPeriod}.`,
        );
      }
      if (transaction.periodResult?.period !== committedPeriod) {
        throw new Error("Period result does not match the committed simulation period.");
      }

      session.simulationState = clone(transaction.simulationState);
      session.allocationDraft = clone(transaction.nextAllocationDraft);
      session.periodTransactions.push({
        uuid: transaction.uuid,
        period: committedPeriod,
        endingStateChecksum: transaction.simulationState.stateChecksum,
        formRecord: clone(transaction.formRecord),
        uploadStatus: transaction.uploadStatus,
        uploadAttempts: transaction.uploadAttempts ?? 0,
        committedAt: this.now(),
        lastUploadAttemptAt: transaction.lastUploadAttemptAt ?? null,
      });
      session.updatedAt = this.now();
      return session;
    });
  }

  async markPeriodUpload(gameCode, teamCode, uuid, uploadStatus) {
    requireUuid(uuid, "Period transaction");
    requireUploadStatus(uploadStatus);
    return this.#updateTeam(gameCode, teamCode, (session) => {
      requireRecord(session, "No matching saved team session exists.");
      const transaction = session.periodTransactions.find((item) => item.uuid === uuid);
      requireRecord(transaction, `No saved period transaction has UUID ${uuid}.`);
      transaction.uploadStatus = uploadStatus;
      transaction.uploadAttempts += 1;
      transaction.lastUploadAttemptAt = this.now();
      session.updatedAt = this.now();
      return session;
    });
  }

  async endTeamSession(gameCode, teamCode, teamEnd) {
    requireUuid(teamEnd?.uuid, "Team End");
    requireUploadStatus(teamEnd?.uploadStatus);
    if (!teamEnd?.encryptedBackup?.fileText || !teamEnd.encryptedBackup.filename) {
      throw new Error("The encrypted game-verification backup is required.");
    }
    if (teamEnd.backupChecksum !== teamEnd.encryptedBackup.checksumSha256) {
      throw new Error("The encrypted backup checksum does not match its saved envelope.");
    }
    return this.#updateTeam(gameCode, teamCode, (session) => {
      requireRecord(session, "No matching saved team session exists.");
      if (session.teamEnd) {
        if (session.teamEnd.uuid !== teamEnd.uuid) {
          throw new Error("This local team session has already ended.");
        }
        if (session.teamEnd.backupChecksum !== teamEnd.backupChecksum) {
          throw new Error("A Team End UUID cannot be reused with a different backup.");
        }
        return session;
      }
      session.status = TEAM_SESSION_STATUS.ENDED;
      session.teamEnd = {
        ...clone(teamEnd),
        completedPeriods: session.simulationState.completedPeriods,
        uploadAttempts: teamEnd.uploadAttempts ?? 0,
        lastUploadAttemptAt: teamEnd.lastUploadAttemptAt ?? null,
        endedAt: this.now(),
      };
      session.updatedAt = this.now();
      return session;
    });
  }

  async markTeamEndUpload(gameCode, teamCode, uuid, uploadStatus) {
    requireUuid(uuid, "Team End");
    requireUploadStatus(uploadStatus);
    return this.#updateTeam(gameCode, teamCode, (session) => {
      requireRecord(session, "No matching saved team session exists.");
      requireRecord(session.teamEnd, "This team session has no saved Team End record.");
      if (session.teamEnd.uuid !== uuid) {
        throw new Error("The Team End UUID does not match the saved finalization.");
      }
      session.teamEnd.uploadStatus = uploadStatus;
      session.teamEnd.uploadAttempts += 1;
      session.teamEnd.lastUploadAttemptAt = this.now();
      session.updatedAt = this.now();
      return session;
    });
  }

  async findInstructorSession(gameCode) {
    const game = normalizeCode(gameCode, "Game code");
    return this.driver.get(
      STORE_NAMES.INSTRUCTOR_SESSIONS,
      instructorSessionKey(game.normalized),
    );
  }

  async createInstructorSession({ gameCode, instructorState }) {
    const game = normalizeCode(gameCode, "Game code");
    const id = instructorSessionKey(game.normalized);
    let created = false;
    const session = await this.driver.update(STORE_NAMES.INSTRUCTOR_SESSIONS, id, (existing) => {
      if (existing) {
        return existing;
      }
      created = true;
      return buildInstructorSession({
        id,
        game,
        instructorState,
        timestamp: this.now(),
      });
    });
    return { created, session };
  }

  async replaceInstructorSession({ gameCode, instructorState }) {
    const game = normalizeCode(gameCode, "Game code");
    const id = instructorSessionKey(game.normalized);
    return this.driver.put(STORE_NAMES.INSTRUCTOR_SESSIONS, buildInstructorSession({
      id,
      game,
      instructorState,
      timestamp: this.now(),
    }));
  }

  async saveInstructorState(gameCode, instructorState) {
    const game = normalizeCode(gameCode, "Game code");
    const id = instructorSessionKey(game.normalized);
    return this.driver.update(STORE_NAMES.INSTRUCTOR_SESSIONS, id, (session) => {
      requireRecord(session, "No matching saved instructor session exists.");
      session.instructorState = clone(instructorState);
      session.updatedAt = this.now();
      return session;
    });
  }

  async #updateTeam(gameCode, teamCode, updater) {
    const identity = normalizeTeamIdentity(gameCode, teamCode);
    return this.driver.update(
      STORE_NAMES.TEAM_SESSIONS,
      teamSessionKey(identity.game.normalized, identity.team.normalized),
      updater,
    );
  }
}
