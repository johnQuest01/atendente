/**
 * Gera hash bcrypt de uma senha lida do stdin.
 * Uso: echo minha_senha | npm run hash-password --workspace server
 *   ou: npm run hash-password --workspace server   (digite e Ctrl+Z/Ctrl+D)
 */
import bcrypt from 'bcryptjs';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<void> {
  const password = await readStdin();
  if (!password) {
    console.error('Informe a senha via stdin (ex.: echo senha | npm run hash-password --workspace server).');
    process.exit(1);
  }
  const hash = await bcrypt.hash(password, 10);
  process.stdout.write(`${hash}\n`);
}

void main();
