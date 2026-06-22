import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import type { Request } from 'express';
import { AppError } from '../utils/errors';

// Gravamos o upload no diretório TEMPORÁRIO DO SO (sempre gravável), e não no
// disco persistente do Render — que pode encher, ficar indisponível ou ser
// recriado num deploy, causando "não foi possível salvar o áudio". O arquivo
// final vai para o storage (R2/S3) logo em seguida.
const tmpDir = path.join(os.tmpdir(), 'mayra-uploads');
fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb: (err: Error | null, dest: string) => void) =>
    cb(null, tmpDir),
  filename: (_req: Request, file: Express.Multer.File, cb: (err: Error | null, name: string) => void) => {
    const ext = path.extname(file.originalname) || '';
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, unique);
  },
});

const AUDIO_MIME = /^(audio\/|video\/webm)/;
const IMAGE_MIME = /^image\//;

export const uploadAudio = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    if (AUDIO_MIME.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('Arquivo de áudio inválido. Envie um formato de áudio suportado.', 422, 'INVALID_FILE'));
    }
  },
});

export const uploadImages = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 6 }, // 10 MB cada, até 6
  fileFilter: (_req, file, cb) => {
    if (IMAGE_MIME.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new AppError('Arquivo de imagem inválido.', 422, 'INVALID_FILE'));
    }
  },
});
