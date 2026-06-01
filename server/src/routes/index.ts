import { Router } from 'express';
import authRoutes from './auth.routes';
import conversationsRoutes from './conversations.routes';
import audiosRoutes from './audios.routes';
import messagesRoutes from './messages.routes';
import productsRoutes from './products.routes';
import keywordsRoutes from './keywords.routes';
import dashboardRoutes from './dashboard.routes';
import settingsRoutes from './settings.routes';
import blockedRoutes from './blocked.routes';

const api = Router();

api.use('/auth', authRoutes);
api.use('/conversations', conversationsRoutes);
api.use('/audios', audiosRoutes);
api.use('/messages', messagesRoutes);
api.use('/products', productsRoutes);
api.use('/keywords', keywordsRoutes);
api.use('/dashboard', dashboardRoutes);
api.use('/settings', settingsRoutes);
api.use('/blocked', blockedRoutes);

export default api;
