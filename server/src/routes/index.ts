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
import adminRoutes from './admin.routes';
import invitesRoutes from './invites.routes';
import broadcastsRoutes from './broadcasts.routes';
import contactsRoutes from './contacts.routes';

const api = Router();

api.use('/auth', authRoutes);
// Público: quem abre um convite ainda não tem conta.
api.use('/invites', invitesRoutes);
api.use('/conversations', conversationsRoutes);
api.use('/audios', audiosRoutes);
api.use('/messages', messagesRoutes);
api.use('/products', productsRoutes);
api.use('/keywords', keywordsRoutes);
api.use('/dashboard', dashboardRoutes);
api.use('/settings', settingsRoutes);
api.use('/blocked', blockedRoutes);
api.use('/admin', adminRoutes);
api.use('/broadcasts', broadcastsRoutes);
api.use('/contacts', contactsRoutes);

export default api;
