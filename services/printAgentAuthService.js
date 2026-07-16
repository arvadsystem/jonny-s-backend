import crypto from 'node:crypto';
import pool from '../config/db-connection.js';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const safeEqualHex = (left, right) => {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
};
export const hashPrintAgentToken = (token) => sha256(String(token || ''));

export const authenticatePrintAgent = async ({ agentId, token, db = pool }) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(agentId || '')) || String(token || '').length < 32) return null;
  const result = await db.query(
    `SELECT id_agente, id_sucursal, nombre, estado, token_hash
       FROM public.agentes_impresion WHERE id_agente = $1 LIMIT 1`,
    [agentId]
  );
  const agent = result.rows[0];
  if (!agent || agent.estado !== 'activo' || !safeEqualHex(hashPrintAgentToken(token), agent.token_hash)) return null;
  return {
    id_agente: agent.id_agente,
    id_sucursal: Number(agent.id_sucursal),
    nombre: agent.nombre
  };
};
