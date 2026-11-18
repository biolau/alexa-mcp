/**
 * Authentication script for Alexa MCP Server.
 * Run this once to authenticate with Amazon.
 *
 * Usage: npm run auth
 *
 * This will start a local proxy server. Open the URL in your browser,
 * log in with your Amazon account, and the credentials will be saved locally.
 */

import Alexa from 'alexa-remote2';
import { writeFileSync, mkdirSync, existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

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

// auth.json holds a live Amazon session, so it must be readable only by this
// user. Two things defeat that on Windows: Node's chmod only toggles the
// read-only bit (it cannot express owner-only), and a new file inherits the
// volume's ACEs — on a typical box that is `Users: ReadAndExecute` and
// `Authenticated Users: Modify`, i.e. every local account could read the
// cookie. So on win32 strip the inherited ACEs and grant only the current
// user; everywhere else keep the usual 0600 chmod.
function hardenSecret(target) {
  if (process.platform === 'win32') {
    try {
      const me = execFileSync('whoami', [], { encoding: 'utf8' }).trim();
      execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `${me}:F`], {
        stdio: 'pipe',
      });
      return;
    } catch (e) {
      console.log(`(warning) could not tighten NTFS ACL on ${target}: ${e.message}`);
      return;
    }
  }
  try {
    chmodSync(target, 0o600);
  } catch (e) {
    console.log(`(warning) chmod 600 failed on ${target}: ${e.message}`);
  }
}

if (!existsSync(AUTH_DIR)) {
  mkdirSync(AUTH_DIR, { recursive: true });
}
hardenSecret(AUTH_DIR);

const alexa = new Alexa();
const PROXY_PORT = 3457;

// The auth proxy sits in front of amazon.com and carries the login, cookies
// included, for the whole flow. Binding it to every interface exposes it to
// anything on the LAN for that window, so bind loopback by default and let
// anyone who really wants a LAN proxy opt in explicitly.
const PROXY_BIND = process.env.ALEXA_AUTH_PROXY_BIND || '127.0.0.1';

console.log('');
console.log('=== Alexa MCP Server - Autenticacion ===');
console.log('');

alexa.init(
  {
    cookie: '',
    proxyOnly: true,
    proxyOwnIp: 'localhost',
    proxyPort: PROXY_PORT,
    proxyListenBind: PROXY_BIND,
    amazonPage: 'amazon.com',
    acceptLanguage: 'en-US',
    amazonPageProxyLanguage: 'en_US',
    useWsMqtt: false,
    proxyLogLevel: 'warn',
  },
  (err) => {
    // The callback fires TWICE in proxyOnly mode:
    // 1st: with an error containing "Please open..." (proxy is ready)
    // 2nd: with null error after successful auth (cookie obtained)

    if (err) {
      const msg = err.message || String(err);

      // This is the expected "proxy ready" message - NOT a real error
      if (msg.includes('Please open') || msg.includes('browser')) {
        console.log('Proxy listo. Abre esta URL en tu navegador:');
        console.log('');
        console.log(`  http://localhost:${PROXY_PORT}`);
        console.log('');
        console.log('Inicia sesion con tu cuenta de Amazon.');
        console.log('Esperando autenticacion...');
        console.log('');
        return;
      }

      // Some accounts complete the cookie capture but fail the post-auth
      // device-registration step. If we got the cookie, persist it anyway —
      // the MCP server only needs the cookie to make API calls.
      if (alexa.cookie) {
        if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
        const authData = {
          cookie: alexa.cookie,
          formerRegistrationData: alexa.cookieData || {},
          amazonPage: (alexa.cookieData && alexa.cookieData.amazonPage) || 'amazon.com',
          authenticatedAt: new Date().toISOString(),
        };
        writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2), 'utf8');
        hardenSecret(AUTH_FILE);
        console.log('');
        console.log(`Advertencia post-auth: ${msg}`);
        console.log('Cookie capturada y guardada de todos modos.');
        console.log(`Credenciales guardadas en: ${AUTH_FILE}`);
        setTimeout(() => process.exit(0), 1000);
        return;
      }

      // Real error without cookie
      console.error('Error durante la autenticacion:', msg);
      process.exit(1);
    }

    // Success! Cookie obtained
    const authData = {
      cookie: alexa.cookie,
      formerRegistrationData: alexa.cookieData,
      amazonPage: (alexa.cookieData && alexa.cookieData.amazonPage) || 'amazon.com',
      authenticatedAt: new Date().toISOString(),
    };

    writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2), 'utf8');
    hardenSecret(AUTH_FILE);

    console.log('');
    console.log('Autenticacion exitosa!');
    console.log(`Credenciales guardadas en: ${AUTH_FILE}`);
    console.log('');
    console.log('Ya puedes cerrar este proceso con Ctrl+C.');
    console.log('');

    setTimeout(() => process.exit(0), 2000);
  }
);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nCerrando...');
  process.exit(0);
});
