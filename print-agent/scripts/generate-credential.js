import crypto from 'node:crypto';

const branchId = Number.parseInt(process.argv[2] || '', 10);
const name = String(process.argv.slice(3).join(' ') || '').trim();
if (!Number.isInteger(branchId) || branchId <= 0 || !name || name.length > 120) {
  console.error('Uso: npm run credential:generate -- <BRANCH_ID> "Nombre del agente"');
  process.exit(1);
}
const agentId = crypto.randomUUID();
const token = crypto.randomBytes(48).toString('base64url');
const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
console.log('Credencial generada. Guarde el token en el administrador de secretos; solo se muestra una vez.');
console.log(`PRINT_AGENT_ID=${agentId}`);
console.log(`PRINT_AGENT_TOKEN=${token}`);
console.log('\nProvisionar con una consulta parametrizada equivalente a:');
console.log('INSERT INTO public.agentes_impresion (id_agente,id_sucursal,nombre,token_hash,token_ultimos_4) VALUES ($1,$2,$3,$4,$5);');
console.log(JSON.stringify({ values: [agentId, branchId, name, hash, token.slice(-4)] }));
