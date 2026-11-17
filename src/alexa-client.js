import Alexa from 'alexa-remote2';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  renameSync,
  copyFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveAuthDir() {
  const envDir = process.env.ALEXA_MCP_AUTH_DIR;
  if (envDir) {
    return envDir.startsWith('~/') ? join(homedir(), envDir.slice(2)) : envDir;
  }
  return join(__dirname, '..', '.auth-data');
}

const AUTH_DIR = resolveAuthDir();
const AUTH_FILE = join(AUTH_DIR, 'auth.json');
const STATE_CACHE_FILE = join(AUTH_DIR, 'state-cache.json');

// Amazon rate-limits unofficial clients with "Too many requests"
// (UNOFFICIAL_CLIENT_TOO_MANY_REQUESTS, isRetryable: false): fast retries only
// extend the block. So: fail fast per request, retry a couple of times with a
// wide gap, then cool down with an escalating window that serves the last
// known state from disk instead of burning more quota.
const QUERY_TIMEOUT_MS = 25_000;
const THROTTLE_RETRY_DELAYS_MS = [3_000, 10_000];
const COOLDOWN_BASE_MS = 60_000;
const COOLDOWN_MAX_MS = 10 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottled(result) {
  if (!result || typeof result !== 'object') return false;
  if (/too many requests/i.test(result.message || '')) return true;
  return (result.errors || []).some(
    (e) => /too many requests/i.test((e && e.message) || '')
  );
}

/**
 * A registration is only usable if it carries everything alexa-remote2 needs
 * to authenticate without a browser: the session cookie, the refresh token and
 * the signing keys (macDms). Anything less means a login prompt later on.
 */
function isCompleteRegistration(reg) {
  return !!(
    reg &&
    typeof reg.localCookie === 'string' &&
    reg.localCookie.length > 0 &&
    reg.refreshToken &&
    reg.macDms &&
    reg.macDms.adp_token &&
    reg.macDms.device_private_key
  );
}

export class AlexaClient {
  constructor() {
    this.alexa = new Alexa();
    this.initialized = false;
    this._throttleUntil = 0;
    this._throttleHits = 0;
    this._stateCache = null;
  }

  async init() {
    if (this.initialized) return;

    const savedAuth = this._loadAuth();
    if (!savedAuth) {
      throw new Error(
        'No authentication data found. Run "npm run auth" first to authenticate with Amazon.'
      );
    }

    const registration = savedAuth.formerRegistrationData;
    const seenTokenDate = registration && registration.tokenDate;

    // Persist every registration alexa-remote2 hands us. It emits 'cookie'
    // after the initial load and again after each refresh; only the refreshes
    // carry a new tokenDate, and those are the ones that must reach disk, or
    // the next process would refresh from an already-rotated refreshToken and
    // Amazon would send us back to the login page.
    if (!this._persistListenerAttached) {
      this._persistListenerAttached = true;
      this.alexa.on('cookie', () => {
        const fresh = this.alexa.cookieData;
        if (!isCompleteRegistration(fresh)) return;
        if (fresh.tokenDate === seenTokenDate) return;
        this._saveAuth({
          cookie: fresh.localCookie,
          formerRegistrationData: fresh,
          amazonPage: fresh.amazonPage || savedAuth.amazonPage || 'amazon.com',
          authenticatedAt: savedAuth.authenticatedAt,
          refreshedAt: new Date().toISOString(),
        });
      });
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout after 30s'));
      }, 30000);

      this.alexa.init(
        {
          // Hand over the whole registration object, not just the cookie
          // string. Given the object, alexa-remote2 recovers macDms and skips
          // the call to Amazon while the token is under 24h old; given a bare
          // string it cannot, and every single init rotates the token.
          cookie: isCompleteRegistration(registration)
            ? registration
            : savedAuth.cookie,
          formerRegistrationData: registration,
          macDms: registration && registration.macDms,
          proxyOwnIp: '127.0.0.1',
          proxyPort: 0,
          amazonPage: savedAuth.amazonPage || 'amazon.com',
          acceptLanguage: 'en-US',
          amazonPageProxyLanguage: 'en_US',
          useWsMqtt: false,
          cookieRefreshInterval: 4 * 24 * 60 * 60 * 1000, // 4 days
        },
        (err) => {
          clearTimeout(timeout);
          if (err) {
            if (err.message && err.message.includes('Cookie')) {
              reject(
                new Error(
                  'Authentication expired. Run "npm run auth" to re-authenticate.'
                )
              );
            } else {
              reject(err);
            }
            return;
          }
          this.initialized = true;
          resolve();
        }
      );
    });
  }

  // --- Device Management ---

  async getDevices() {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.getDevices((err, result) => {
        if (err) return reject(err);
        const devices = (result?.devices || []).map((d) => ({
          name: d.accountName,
          serialNumber: d.serialNumber,
          deviceType: d.deviceType,
          deviceFamily: d.deviceFamily,
          online: d.online,
          capabilities: d.capabilities,
        }));
        resolve(devices);
      });
    });
  }

  // --- Smart Home ---

  async getSmarthomeDevices() {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.getSmarthomeDevicesV2((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  async getSmarthomeGroups() {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.getSmarthomeGroups((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  async querySmarthomeDevices(entityIds, { force = false } = {}) {
    await this.init();

    // Cooldown after a recent throttle: answer from cache, do not touch Amazon
    // again (the block is not instantly retryable, and every hammering call
    // extends it).
    if (!force && this._throttleUntil > Date.now()) {
      return this._cachedOnly(entityIds, {
        throttled: true,
        message:
          `Amazon is rate-limiting this client; next live query allowed after ` +
          `${new Date(this._throttleUntil).toISOString()} (pass force: true to try anyway).`,
      });
    }

    const query = (ids, entityType) =>
      new Promise((resolve, reject) => {
        // alexa-remote2 can hang on a stalled request; without this the whole
        // MCP call hangs until the client gives up.
        const timer = setTimeout(() => {
          reject(new Error(`Smart home state query timed out after ${QUERY_TIMEOUT_MS / 1000}s`));
        }, QUERY_TIMEOUT_MS);
        this.alexa.querySmarthomeDevices(
          ids.map((id) => ({ entityId: id, entityType })),
          (err, result) => {
            clearTimeout(timer);
            if (err) return reject(err);
            resolve(result || {});
          }
        );
      });

    let result = {};
    let liveError = null;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await query(entityIds, 'APPLIANCE');
        if (!isThrottled(result)) break;
      } catch (err) {
        liveError = err;
        break;
      }
      if (attempt >= THROTTLE_RETRY_DELAYS_MS.length) break;
      await sleep(THROTTLE_RETRY_DELAYS_MS[attempt]);
    }

    if (isThrottled(result)) {
      this._throttleHits += 1;
      const cooldown = Math.min(
        COOLDOWN_BASE_MS * 2 ** (this._throttleHits - 1),
        COOLDOWN_MAX_MS
      );
      this._throttleUntil = Date.now() + cooldown;
      return this._cachedOnly(entityIds, {
        throttled: true,
        message:
          `Amazon rate-limited this client (Too many requests). Cooling down ` +
          `${Math.round(cooldown / 1000)}s; last known state below is served from cache.`,
      });
    }

    if (liveError && !(result.deviceStates || []).length) {
      return this._cachedOnly(entityIds, {
        message: `Live query failed (${liveError.message}); last known state below is from cache.`,
      });
    }

    this._throttleHits = 0;
    this._throttleUntil = 0;

    // Echo-hosted endpoints (temperature sensors, acoustic sensors) are
    // components of the Echo device, and /api/phoenix/state only answers for
    // them with entityType ENTITY; plain appliances need APPLIANCE. Query as
    // APPLIANCE first, then retry whatever Amazon rejected as ENTITY.
    const missing = new Set(entityIds);
    for (const ds of result.deviceStates || []) {
      if (ds.entity && ds.entity.entityId) missing.delete(ds.entity.entityId);
    }
    if (missing.size) {
      try {
        const retry = await query([...missing], 'ENTITY');
        if (!isThrottled(retry)) {
          result.deviceStates = (result.deviceStates || []).concat(
            retry.deviceStates || []
          );
          // TargetApplianceNotFoundException for the retried ids is now stale
          result.errors = (result.errors || []).filter(
            (e) => !(retry.deviceStates || []).some(
              (ds) => ds.entity && e.entity && ds.entity.entityId === e.entity.entityId
            )
          );
          for (const ds of retry.deviceStates || []) {
            if (ds.entity && ds.entity.entityId) missing.delete(ds.entity.entityId);
          }
        }
      } catch {
        // keep the APPLIANCE result; the cache fills the gaps below
      }
    }

    this._recordStates(result.deviceStates);

    // Amazon sometimes answers for only part of the batch — or for none of it,
    // without any error — and Kasa/Hue devices only push state on change.
    // Serve whatever is still missing from cache instead of an empty success.
    if (missing.size) {
      const cache = this._loadStateCache();
      const stale = [];
      for (const id of missing) {
        if (cache[id]) {
          stale.push({ ...cache[id], fromCache: true });
          missing.delete(id);
        }
      }
      if (stale.length) {
        result.deviceStates = (result.deviceStates || []).concat(stale);
      }
      result.partial = {
        message: stale.length
          ? 'Some devices were served from cached state (Amazon answered empty for them).'
          : 'Amazon answered empty for these devices and no cached state exists yet.',
        cachedCount: stale.length,
        missingEntityIds: [...missing],
      };
    }
    return result;
  }

  _cachedOnly(entityIds, extra = {}) {
    const cache = this._loadStateCache();
    const deviceStates = [];
    const missingEntityIds = [];
    for (const id of entityIds) {
      if (cache[id]) deviceStates.push({ ...cache[id], fromCache: true });
      else missingEntityIds.push(id);
    }
    return {
      deviceStates,
      ...(extra.throttled ? { throttled: true } : {}),
      ...(extra.message ? { message: extra.message } : {}),
      ...(missingEntityIds.length
        ? {
            partial: {
              message: 'No cached state for these devices yet.',
              missingEntityIds,
            },
          }
        : {}),
    };
  }

  _loadStateCache() {
    if (!this._stateCache) {
      try {
        this._stateCache =
          JSON.parse(readFileSync(STATE_CACHE_FILE, 'utf8')).devices || {};
      } catch {
        this._stateCache = {};
      }
    }
    return this._stateCache;
  }

  _recordStates(deviceStates) {
    if (!deviceStates || !deviceStates.length) return;
    const cache = this._loadStateCache();
    let changed = false;
    for (const ds of deviceStates) {
      if (
        ds &&
        ds.entity &&
        ds.entity.entityId &&
        !ds.fromCache &&
        Array.isArray(ds.capabilityStates) &&
        ds.capabilityStates.length
      ) {
        cache[ds.entity.entityId] = ds;
        changed = true;
      }
    }
    if (!changed) return;
    try {
      // Atomic write, same pattern as _saveAuth: a crash must not leave a
      // truncated cache behind.
      const tmp = `${STATE_CACHE_FILE}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ updatedAt: new Date().toISOString(), devices: cache }, null, 2),
        'utf8'
      );
      renameSync(tmp, STATE_CACHE_FILE);
    } catch {
      // best-effort: the in-memory copy still serves this process
    }
  }

  // --- Announcements ---

  async announce(serialNumber, message) {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.sendSequenceCommand(
        serialNumber,
        'announcement',
        message,
        (err) => {
          if (err) return reject(err);
          resolve({ success: true });
        }
      );
    });
  }

  async speakSSML(serialNumber, ssml) {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.sendSequenceCommand(serialNumber, 'ssml', ssml, (err) => {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  }

  async textCommand(serialNumber, text) {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.sendSequenceCommand(
        serialNumber,
        'textCommand',
        text,
        (err) => {
          if (err) return reject(err);
          resolve({ success: true });
        }
      );
    });
  }

  // --- Volume ---

  async setVolume(serialNumber, volume) {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.sendSequenceCommand(
        serialNumber,
        'volume',
        volume,
        (err) => {
          if (err) return reject(err);
          resolve({ success: true });
        }
      );
    });
  }

  async getAllDeviceVolumes() {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.getAllDeviceVolumes((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // --- Routines ---

  async getRoutines() {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.getAutomationRoutines((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  async executeRoutine(routine) {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.executeAutomationRoutine(routine, (err) => {
        if (err) return reject(err);
        resolve({ success: true });
      });
    });
  }

  // --- Lists ---

  async getLists() {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.getListsV2((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  async getListItems(listId) {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.getListItemsV2(listId, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  async addListItem(listId, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.addListItem(listId, value, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // --- Group Management ---

  _enrichCookie() {
    const cookie = this.alexa.cookie;
    if (!cookie) return;
    const cookies = {};
    cookie.split(';').forEach((c) => {
      const [name, ...rest] = c.trim().split('=');
      cookies[name] = rest.join('=');
    });
    let enriched = cookie;
    // Add at-main/ubid-main aliases for regional cookies (required for write ops)
    for (const suffix of ['acbmx', 'acbus', 'acbde', 'acbuk', 'acbjp', 'acbin']) {
      if (cookies[`at-${suffix}`] && !cookies['at-main']) {
        enriched += `; at-main=${cookies[`at-${suffix}`]}`;
      }
      if (cookies[`ubid-${suffix}`] && !cookies['ubid-main']) {
        enriched += `; ubid-main=${cookies[`ubid-${suffix}`]}`;
      }
    }
    this.alexa.cookie = enriched;
  }

  async createSmarthomeGroup(name, applianceIds) {
    await this.init();
    this._enrichCookie();
    return new Promise((resolve, reject) => {
      const flags = {
        method: 'POST',
        data: JSON.stringify({
          name,
          type: 'SPACE',
          applianceIds: applianceIds || [],
        }),
      };
      this.alexa.httpsGet('/api/phoenix/group', (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }, flags);
    });
  }

  async updateSmarthomeGroup(groupId, name, applianceIds) {
    await this.init();
    this._enrichCookie();
    return new Promise((resolve, reject) => {
      const flags = {
        method: 'PUT',
        data: JSON.stringify({
          name,
          applianceIds: applianceIds || [],
        }),
      };
      this.alexa.httpsGet(`/api/phoenix/group/${groupId}`, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      }, flags);
    });
  }

  async deleteSmarthomeGroup(groupId) {
    await this.init();
    this._enrichCookie();
    return new Promise((resolve, reject) => {
      this.alexa.deleteSmarthomeGroup(groupId, (err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // --- Bluetooth ---

  async getBluetoothDevices() {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.getBluetoothDevices((err, result) => {
        if (err) return reject(err);
        resolve(result);
      });
    });
  }

  // --- Do Not Disturb ---

  async setDoNotDisturb(serialNumber, enabled) {
    await this.init();
    return new Promise((resolve, reject) => {
      this.alexa.sendSequenceCommand(
        serialNumber,
        'deviceDoNotDisturb',
        enabled,
        (err) => {
          if (err) return reject(err);
          resolve({ success: true });
        }
      );
    });
  }

  // --- Auth helpers ---

  _loadAuth() {
    if (!existsSync(AUTH_FILE)) return null;
    try {
      return JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
    } catch {
      return null;
    }
  }

  _saveAuth(data) {
    if (!isCompleteRegistration(data && data.formerRegistrationData)) {
      // Never let a partial refresh overwrite a working registration.
      return false;
    }
    try {
      if (existsSync(AUTH_FILE)) copyFileSync(AUTH_FILE, `${AUTH_FILE}.prev`);
      // Write to a temp file and rename, so a crash mid-write cannot leave a
      // truncated auth.json behind (that also costs a full re-login).
      const tmp = `${AUTH_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      chmodSync(tmp, 0o600);
      renameSync(tmp, AUTH_FILE);
      return true;
    } catch {
      return false;
    }
  }
}
