/**
 * Gera o hash de uma senha lida do stdin, para colar em BLOCK_ADMIN_PASSWORD_HASH.
 *
 * Usa o MESMO algoritmo das senhas de usuário (scrypt, memory-hard). O hash do
 * cadeado vive numa variável de ambiente e por isso nunca passa pelo rehash
 * automático do login — se fosse gerado em bcrypt, ficaria no formato fraco
 * para sempre.
 *
 * Uso (sem deixar a senha no histórico do terminal):
 *   npm run hash-password --workspace server
 *   ...digite a senha, Enter, e então Ctrl+Z + Enter (Windows) ou Ctrl+D (Linux/Mac)
 *
 * Alternativa rápida (a senha FICA no histórico do shell):
 *   echo minha_senha | npm run hash-password --workspace server
 */
import { hashPassword } from '../src/utils/password';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(): Promise<void> {
  if (process.stdin.isTTY) {
    process.stderr.write('Digite a senha e finalize com Ctrl+Z + Enter (Windows) ou Ctrl+D:\n');
  }
  const password = await readStdin();
  if (!password) {
    console.error('Nenhuma senha recebida. Ex.: echo senha | npm run hash-password --workspace server');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Senha muito curta — use ao menos 8 caracteres.');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  // O hash sai sozinho no stdout, para dar pipe ou copiar sem sujeira em volta.
  process.stdout.write(`${hash}\n`);
}

void main();
