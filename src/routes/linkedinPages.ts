import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { prisma } from '../prismaClient';
import axios from 'axios';
import { config } from '../config';

const router = Router();


// Get user's LinkedIn organizations/pages
router.get('/pages', requireAuth, async (req, res) => {
    
    try {
        const linkedInAccount = await prisma.linkedInAccount.findFirst({
            where: { userId: req.userId! }
        });

        if (!linkedInAccount) {
            return res.status(404).json({ error: 'LinkedIn account not connected' });
        }

        // Fetch organizations the user administers
        const response = await axios.get(
            'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee&projection=(elements*(organization~(localizedName,vanityName),roleAssignee,state))',
            {
                headers: {
                    Authorization: `Bearer ${linkedInAccount.accessToken}`,
                    'X-Restli-Protocol-Version': '2.0.0',
                    'Linkedin-Version': config.linkedin.apiVersion
                }
            }
        );

        const organizations = response.data.elements
            .filter((acl: any) => acl.state === 'APPROVED')
            .map((acl: any) => ({
                urn: acl.organization,
                name: acl['organization~']?.localizedName || 'Unknown',
                vanityName: acl['organization~']?.vanityName || ''
            }));

        res.json({
            organizations,
            selectedOrganizationUrn: linkedInAccount.selectedOrganizationUrn
        });
    } catch (error: any) {
        console.error('Failed to fetch LinkedIn pages:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch LinkedIn pages' });
    }
});

// Select a page/organization to post to
router.post('/pages/select', requireAuth, async (req, res) => {
    const { organizationUrn } = req.body;

    try {
        const linkedInAccount = await prisma.linkedInAccount.findFirst({
            where: { userId: req.userId! }
        });

        if (!linkedInAccount) {
            return res.status(404).json({ error: 'LinkedIn account not connected' });
        }

        await prisma.linkedInAccount.update({
            where: { id: linkedInAccount.id },
            data: { selectedOrganizationUrn: organizationUrn || null }
        });

        res.json({ success: true, selectedOrganizationUrn: organizationUrn });
    } catch (error) {
        console.error('Failed to select page:', error);
        res.status(500).json({ error: 'Failed to select page' });
    }
});

export default router;
