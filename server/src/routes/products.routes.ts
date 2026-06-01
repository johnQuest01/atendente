import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate } from '../middleware/auth.middleware';
import { uploadImages } from '../middleware/upload.middleware';
import {
  createProductSchema,
  getProduct,
  getProducts,
  idParamSchema,
  patchProduct,
  postProduct,
  removeProduct,
  updateProductSchema,
  uploadProductImages,
} from '../controllers/products.controller';

const router = Router();

router.use(authenticate);

router.get('/', asyncHandler(getProducts));
router.get('/:id', validate({ params: idParamSchema }), asyncHandler(getProduct));
router.post('/', validate({ body: createProductSchema }), asyncHandler(postProduct));
router.post('/upload', uploadImages.array('images', 6), asyncHandler(uploadProductImages));
router.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateProductSchema }),
  asyncHandler(patchProduct),
);
router.delete('/:id', validate({ params: idParamSchema }), asyncHandler(removeProduct));

export default router;
