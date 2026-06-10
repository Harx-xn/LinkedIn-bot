import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/billing/notificationService';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const notifications = await listUserNotifications(userId);
  return res.json({ notifications });
});

router.patch('/:id/read', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const updated = await markNotificationRead(userId, req.params.id);
  if (!updated) {
    return res.status(404).json({ error: 'Notification not found' });
  }
  return res.json({ notification: updated });
});

router.patch('/read-all', requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  await markAllNotificationsRead(userId);
  return res.json({ ok: true });
});

export default router;
