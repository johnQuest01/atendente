import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env';
import { AppError } from '../utils/errors';

// Garante que o diretório de uploads exista (dev local).
const tmpDir = path.join(env.uploadDirAbsolute, 'tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, tmpDir),
  filename: (_req, file, cb) => {
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
