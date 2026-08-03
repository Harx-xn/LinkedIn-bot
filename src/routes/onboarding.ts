import { Router, Request } from 'express';
import { requireAuth } from '../middleware/auth';
import { enhanceProfileDescription, ProfileOnboardingError, saveProfileOnboarding } from '../services/profileOnboardingService';

const router = Router();
router.post('/profile/enhance-description', requireAuth, async (req: Request, res: any) => {
  try {
    return res.json({ description: await enhanceProfileDescription(req.userId!, req.body?.description) });
  } catch (error) {
    if (error instanceof ProfileOnboardingError) {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message, fields: error.fields });
    }
    console.error('[onboarding/profile/enhance-description] Enhancement failed:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({ success: false, message: 'We couldn’t enhance your description. Please try again.' });
  }
});
router.put('/profile', requireAuth, async (req: Request, res: any) => {
  try { return res.json(await saveProfileOnboarding(req.userId!, req.body)); }
  catch (error) {
    if (error instanceof ProfileOnboardingError) {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message, fields: error.fields });
    }
    console.error('[onboarding/profile] Failed to save profile:', error instanceof Error ? error.message : 'Unknown error');
    return res.status(500).json({ success: false, message: 'We couldn’t save your profile. Please try again.' });
  }
});
export default router;
