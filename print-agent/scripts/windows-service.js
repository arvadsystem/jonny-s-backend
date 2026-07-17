import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodeWindows from 'node-windows';

const action = String(process.argv[2] || '').toLowerCase();
if (!['install', 'uninstall'].includes(action)) throw new Error('Use install o uninstall.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = new nodeWindows.Service({
  name: 'Jonnys Branch Print Agent',
  description: 'Agente local de impresion por sucursal de Jonnys SmartOrder',
  script: path.join(root, 'src', 'index.js'),
  workingDirectory: root,
  nodeOptions: [],
  env: [{ name: 'NODE_ENV', value: 'production' }]
});
service.on('install', () => { service.start(); console.log('Servicio instalado e iniciado.'); });
service.on('uninstall', () => console.log('Servicio desinstalado.'));
service.on('error', (error) => { console.error('Error del servicio:', error.message); process.exitCode = 1; });
if (action === 'install') service.install(); else service.uninstall();
