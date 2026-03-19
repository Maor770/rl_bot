'use strict';
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('./authMiddleware');
const { getGlobalStats } = require('../db/campaignMigrations');
const { listCampaigns, getCampaignStats } = require('../db/campaignMigrations');

router.use(authMiddleware);

// ── GET /admin/stats/global ───────────────────────────────────────────────────
router.get('/global', async (req, res) => {
  try {
    const stats = await getGlobalStats();
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /admin/stats/campaigns ────────────────────────────────────────────────
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await listCampaigns();
    const results = await Promise.all(
      campaigns.slice(0, 20).map(async (c) => {
        const stats = await getCampaignStats(c.id);
        return { ...c, stats: stats.summary };
      })
    );
    res.json({ ok: true, campaigns: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
