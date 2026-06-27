import 'dotenv/config';

const PROCESS_ROLE = String(process.env.PROCESS_ROLE || 'web').trim().toLowerCase();

if (PROCESS_ROLE === 'web') {
  await import('./server.js');
} else if (PROCESS_ROLE === 'scheduler') {
  await import('./scheduler.js');
} else {
  throw new Error(`PROCESS_ROLE invalido: ${PROCESS_ROLE}. Use web o scheduler.`);
}
