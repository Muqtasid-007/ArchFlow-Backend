import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import authRoutes from './authRoutes.js';
import boardRoutes from './boardRoutes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/boards', authenticate, boardRoutes);

export default router;
