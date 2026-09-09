import { Router } from 'express';
import sessionRoutes from './sessionRoutes.js';
import messageRoutes from './messageRoutes.js';
import chatRoutes from './chatRoutes.js';
import groupRoutes from './groupRoutes.js';
import contactRoutes from './contactRoutes.js';
import mediaRoutes from './mediaRoutes.js';
import privacyRoutes from './privacyRoutes.js';
import usyncRoutes from './usyncRoutes.js';

export function mountRoutes(app) {
  const api = Router();

  api.use('/sessions', sessionRoutes);
  api.use('/sessions/:sessionId/messages', messageRoutes);
  api.use('/sessions/:sessionId/chats', chatRoutes);
  api.use('/sessions/:sessionId/groups', groupRoutes);
  api.use('/sessions/:sessionId/contacts', contactRoutes);
  api.use('/sessions/:sessionId/media', mediaRoutes);
  api.use('/sessions/:sessionId/privacy', privacyRoutes);
  api.use('/sessions/:sessionId/usync', usyncRoutes);

  app.use('/api', api);
}
