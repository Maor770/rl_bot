'use strict';
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

const { authMiddleware } = require('./authMiddleware');
const {
  getCampaign, listCampaigns, createCampaign,
  updateCampaign, getCampaignStats, getPendingLogs
} = require('../db/campaignMigrations');
const {
  createMetaTemplate, checkTemplateStatus,
  prepareCampaign, sendPreviewToAdmin
} = require('../modules/broadcast');
const { loadFromFile, getContactsSummary } = require('../modules/contactParser');
const { filterContactsByCountry } = require('../modules/timezoneMapper');

// Multer for CSV uploads (stored in /tmp)
const upload = multer({
  dest: '/tmp/campaign_uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files allowed'));
    }
  }
});

// All routes require auth
router.use(authMiddleware);

// ── GET /admin/campaigns ──────────────────────────────────────────────────────
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await listCampaigns();
    res.json({ ok: true, campaigns });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /admin/campaigns/:id ──────────────────────────────────────────────────
router.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, campaign });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /admin/campaigns ─────────────────────────────────────────────────────
router.post('/campaigns', async (req, res) => {
  try {
    const campaign = await createCampaign(req.body);
    res.json({ ok: true, campaign });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PATCH /admin/campaigns/:id ────────────────────────────────────────────────
router.patch('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await updateCampaign(Number(req.params.id), req.body);
    res.json({ ok: true, campaign });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /admin/campaigns/:id/stats ────────────────────────────────────────────
router.get('/campaigns/:id/stats', async (req, res) => {
  try {
    const stats = await getCampaignStats(Number(req.params.id));
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /admin/campaigns/:id/submit-template ─────────────────────────────────
// Submit template to Meta for approval
router.post('/campaigns/:id/submit-template', async (req, res) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ ok: false, error: 'Not found' });
    if (!campaign.template_name) return res.status(400).json({ ok: false, error: 'template_name required' });

    const result = await createMetaTemplate(campaign);
    await updateCampaign(campaign.id, { meta_template_status: 'pending' });

    res.json({ ok: true, meta: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /admin/campaigns/:id/template-status ──────────────────────────────────
router.get('/campaigns/:id/template-status', async (req, res) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ ok: false, error: 'Not found' });

    const status = await checkTemplateStatus(campaign.template_name);
    if (status) {
      await updateCampaign(campaign.id, {
        meta_template_status: status.toLowerCase(),
        status: status === 'APPROVED' ? 'approved' : campaign.status,
      });
    }

    res.json({ ok: true, template_status: status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /admin/campaigns/:id/preview ─────────────────────────────────────────
// Send preview to ADMIN_PHONE
router.post('/campaigns/:id/preview', async (req, res) => {
  try {
    const campaign = await getCampaign(Number(req.params.id));
    if (!campaign) return res.status(404).json({ ok: false, error: 'Not found' });

    const result = await sendPreviewToAdmin(campaign);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /admin/campaigns/:id/pause ───────────────────────────────────────────
router.post('/campaigns/:id/pause', async (req, res) => {
  try {
    await updateCampaign(Number(req.params.id), { status: 'paused' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /admin/campaigns/:id/resume ──────────────────────────────────────────
router.post('/campaigns/:id/resume', async (req, res) => {
  try {
    await updateCampaign(Number(req.params.id), { status: 'approved' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /admin/upload-contacts ───────────────────────────────────────────────
// Upload CSV and get contacts summary
router.post('/upload-contacts', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

    const contacts = loadFromFile(req.file.path);
    const countryFilter = req.body.country_filter || 'all';
    const filtered = filterContactsByCountry(contacts, countryFilter);
    const summary  = getContactsSummary(filtered);

    // Save contacts to temp path for later use
    const contactsPath = req.file.path + '_parsed.json';
    fs.writeFileSync(contactsPath, JSON.stringify(filtered));

    // Clean up original
    fs.unlinkSync(req.file.path);

    res.json({
      ok: true,
      total: filtered.length,
      summary,
      contacts_path: contactsPath, // used in /prepare
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /admin/campaigns/:id/prepare ────────────────────────────────────────
// Load contacts and write pending log rows
router.post('/campaigns/:id/prepare', async (req, res) => {
  try {
    const { contacts_path, contacts } = req.body;

    let contactList;
    if (contacts_path && fs.existsSync(contacts_path)) {
      contactList = JSON.parse(fs.readFileSync(contacts_path, 'utf-8'));
      fs.unlinkSync(contacts_path); // clean up
    } else if (Array.isArray(contacts)) {
      contactList = contacts;
    } else {
      return res.status(400).json({ ok: false, error: 'contacts or contacts_path required' });
    }

    const result = await prepareCampaign(Number(req.params.id), contactList);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
