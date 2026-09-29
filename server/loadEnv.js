// Load local operator configuration before database/auth modules are evaluated.
// Existing process environment values retain precedence.
try {
  process.loadEnvFile('.env');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
