import { Router } from 'express';
import authRoutes from './auth.routes';
import conversationsRoutes from './conversations.routes';
import audiosRoutes from './audios.routes';
import messagesRoutes from './messages.routes';
import productsRoutes from './products.routes';
import keywordsRoutes from './keywords.routes';
import dashboardRoutes from './dashboard.routes';

const api = Router();

api.use('/auth', authRoutes);
api.use('/conversations', conversationsRoutes);
api.use('/audios', audiosRoutes);
api.use('/messages', messagesRoutes);
api.use('/products', productsRoutes);
api.use('/keywords', keywordsRoutes);
api.use('/dashboard', dashboardRoutes);

export default api;
