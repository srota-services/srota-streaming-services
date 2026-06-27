/**
 * Validates Node.js and npm versions before any npm script or install runs.
 */
const { execSync } = require('child_process');

const REQUIRED_NODE = '26.4.0';
const REQUIRED_NPM = '11.17.0';

function getNodeVersion() {
   return process.version.replace(/^v/, '');
}

function getNpmVersion() {
   try {
      return execSync('npm --version', { encoding: 'utf8' }).trim();
   } catch {
      const userAgent = process.env.npm_config_user_agent || '';
      const match = userAgent.match(/npm\/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
   }
}

function fail(message) {
   console.error(message);
   process.exit(1);
}

const nodeVersion = getNodeVersion();
const npmVersion = getNpmVersion();

if (nodeVersion !== REQUIRED_NODE) {
   fail(
      `Wrong Node.js version: required ${REQUIRED_NODE}, found ${nodeVersion}.\n` +
         'Use nvm/fnm: nvm use (see .nvmrc) or install Node 26.4.0.',
   );
}

if (!npmVersion) {
   fail(`Could not detect npm version. Required npm ${REQUIRED_NPM}.`);
}

if (npmVersion !== REQUIRED_NPM) {
   fail(
      `Wrong npm version: required ${REQUIRED_NPM}, found ${npmVersion}.\n` +
         `Run: npm install -g npm@${REQUIRED_NPM}`,
   );
}
