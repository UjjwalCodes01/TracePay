// Point the app's db() at the test database before any module creates a client.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
// Never let tests reach a real model by accident.
process.env.GENERATION_MODE = 'fixture';
