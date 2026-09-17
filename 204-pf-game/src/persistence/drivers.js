const DATABASE_NAME = "comm204-process-flow-game";
const DATABASE_VERSION = 1;

export const STORE_NAMES = Object.freeze({
  TEAM_SESSIONS: "teamSessions",
  INSTRUCTOR_SESSIONS: "instructorSessions",
});

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
  });
}

export function openGameDatabase(indexedDBFactory = globalThis.indexedDB) {
  if (!indexedDBFactory) {
    return Promise.reject(new Error("IndexedDB is unavailable in this browser context."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDBFactory.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      for (const storeName of Object.values(STORE_NAMES)) {
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName, { keyPath: "id" });
        }
      }
    }, { once: true });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error), { once: true });
    request.addEventListener("blocked", () => {
      reject(new Error("The game database upgrade is blocked by another open tab."));
    }, { once: true });
  });
}

export class IndexedDbDriver {
  constructor(databasePromise = openGameDatabase()) {
    this.databasePromise = databasePromise;
  }

  async get(storeName, key) {
    const database = await this.databasePromise;
    const transaction = database.transaction(storeName, "readonly");
    return requestResult(transaction.objectStore(storeName).get(key));
  }

  async put(storeName, value) {
    const database = await this.databasePromise;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.addEventListener("complete", () => resolve(clone(value)), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
      transaction.objectStore(storeName).put(clone(value));
    });
  }

  async update(storeName, key, updater) {
    const database = await this.databasePromise;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      const getRequest = store.get(key);
      let updated;

      getRequest.addEventListener("success", () => {
        try {
          updated = updater(clone(getRequest.result));
          if (updated === undefined) {
            throw new Error("Persistence updater must return a record.");
          }
          store.put(clone(updated));
        } catch (error) {
          transaction.abort();
          reject(error);
        }
      }, { once: true });
      getRequest.addEventListener("error", () => reject(getRequest.error), { once: true });
      transaction.addEventListener("complete", () => resolve(clone(updated)), { once: true });
      transaction.addEventListener("abort", () => {
        if (transaction.error) {
          reject(transaction.error);
        }
      }, { once: true });
      transaction.addEventListener("error", () => reject(transaction.error), { once: true });
    });
  }
}

export class InMemoryDriver {
  constructor() {
    this.stores = new Map(
      Object.values(STORE_NAMES).map((storeName) => [storeName, new Map()]),
    );
  }

  async get(storeName, key) {
    return clone(this.#store(storeName).get(key));
  }

  async put(storeName, value) {
    this.#store(storeName).set(value.id, clone(value));
    return clone(value);
  }

  async update(storeName, key, updater) {
    const store = this.#store(storeName);
    const updated = updater(clone(store.get(key)));
    if (updated === undefined) {
      throw new Error("Persistence updater must return a record.");
    }
    store.set(key, clone(updated));
    return clone(updated);
  }

  #store(storeName) {
    const store = this.stores.get(storeName);
    if (!store) {
      throw new Error(`Unknown persistence store: ${storeName}`);
    }
    return store;
  }
}
