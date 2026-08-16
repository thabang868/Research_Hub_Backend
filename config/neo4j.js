const neo4j = require('neo4j-driver');

const uri = process.env.NEO4J_URI;
const username = process.env.NEO4J_USERNAME;
const password = process.env.NEO4J_PASSWORD;
const hasCredentials = Boolean(uri && username && password);

const driver = hasCredentials
  ? neo4j.driver(uri, neo4j.auth.basic(username, password))
  : null;

let connectionReady = false;
let connectionAttempted = false;

function getDriverOrThrow() {
  if (!driver) {
    throw new Error('Neo4j is not configured. Set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD in backend/.env.');
  }

  return driver;
}

async function verifyConnection() {
  connectionAttempted = true;

  if (!driver) {
    console.warn('[Neo4j] No connection details configured. Add the Aura or local Neo4j credentials to backend/.env.');
    return false;
  }

  try {
    await Promise.race([
      driver.verifyConnectivity(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Neo4j startup check timed out after 8s')), 8000)),
    ]);

    connectionReady = true;
    console.log('[Neo4j] Connected successfully.');
    return true;
  } catch (err) {
    connectionReady = false;
    console.warn('[Neo4j] Connection failed at startup. Check the values in backend/.env:');
    console.warn(`  - NEO4J_URI: ${uri || 'missing'}`);
    console.warn(`  - NEO4J_USERNAME: ${username || 'missing'}`);
    console.warn('  - NEO4J_PASSWORD: present but may be incorrect or expired.');
    console.warn(`[Neo4j] Details: ${err.message}`);
    return false;
  }
}

async function ensureReady() {
  if (!driver) {
    connectionReady = false;
    return false;
  }

  try {
    await driver.verifyConnectivity();
    connectionReady = true;
    return true;
  } catch (err) {
    connectionReady = false;
    console.warn('[Neo4j] Connection dropped or unavailable, graph features will fallback gracefully.');
    return false;
  }
}

const neo4jDriver = {
  isConfigured: () => Boolean(driver),
  isReady: () => connectionReady,
  wasAttempted: () => connectionAttempted,
  session: (...args) => {
    if (!driver) {
      throw new Error('Neo4j is not configured. Set NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD in backend/.env.');
    }
    return driver.session(...args);
  },
  verifyConnectivity: (...args) => (driver ? driver.verifyConnectivity(...args) : Promise.reject(new Error('Neo4j is not configured.'))),
  ensureReady,
  close: async (...args) => {
    if (!driver) return undefined;
    return driver.close(...args);
  },
  getConnectionInfo: () => ({
    uri: uri || null,
    username: username || null,
    isConfigured: Boolean(driver),
    isReady: connectionReady,
  }),
};

verifyConnection();

module.exports = neo4jDriver;
