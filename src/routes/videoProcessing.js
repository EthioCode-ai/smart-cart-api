const express = require('express');
const db = require('../db');

const router = express.Router();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

router.post('/process-video', async (req, res) => {
  try {
    const { storeId, videoUrl, videoDuration, userId, userLocation } = req.body;

    if (!storeId || !videoUrl) {
      return res.status(400).json({ success: false, error: 'storeId and videoUrl are required' });
    }

    const contributionResult = await db.query(
      `INSERT INTO layout_contributions 
       (store_id, user_id, status, user_latitude, user_longitude)
       VALUES ($1, $2, 'processing', $3, $4)
       RETURNING id`,
      [storeId, userId || '00000000-0000-0000-0000-000000000001', userLocation?.latitude, userLocation?.longitude]
    );

    const contributionId = contributionResult.rows[0].id;

    processVideoAsync(contributionId, storeId, videoUrl, userId)
      .catch(err => console.error('Video processing error:', err));

    res.status(202).json({
      success: true,
      data: { contributionId, status: 'processing', message: 'Video received. Processing will take a few minutes.' }
    });

  } catch (error) {
    console.error('Process video error:', error);
    res.status(500).json({ success: false, error: 'Failed to process video' });
  }
});

router.get('/status/:contributionId', async (req, res) => {
  try {
    const { contributionId } = req.params;

    const result = await db.query(
      `SELECT id, status, points_earned, aisles_contributed, special_areas_contributed, created_at, completed_at
       FROM layout_contributions WHERE id = $1`,
      [contributionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Contribution not found' });
    }

    res.json({ success: true, data: result.rows[0] });

  } catch (error) {
    console.error('Check status error:', error);
    res.status(500).json({ success: false, error: 'Failed to check status' });
  }
});

async function processVideoAsync(contributionId, storeId, videoUrl, userId) {
  const client = await db.pool.connect();
  
  try {
    console.log(`Processing video for contribution ${contributionId}`);

    const frames = extractVideoFrames(videoUrl);
    console.log(`Will analyze ${frames.length} frames`);

    const detections = [];
    for (let i = 0; i < Math.min(frames.length, 50); i++) {
      const detection = await analyzeFrameWithOpenAI(frames[i]);
      if (detection) {
        detections.push({ ...detection, sequence: i + 1 });
      }
    }
    console.log(`Detected ${detections.length} aisle/area signs`);

    const layout = organizeDetections(detections);

    await client.query('BEGIN');

    for (const aisle of layout.aisles) {
      await client.query(
        `INSERT INTO store_aisles (store_id, aisle_number, aisle_description, categories, sequence_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (store_id, aisle_number) 
         DO UPDATE SET aisle_description = COALESCE(EXCLUDED.aisle_description, store_aisles.aisle_description),
           categories = EXCLUDED.categories, sequence_order = EXCLUDED.sequence_order,
           contribution_count = store_aisles.contribution_count + 1, updated_at = NOW()`,
        [storeId, aisle.number, aisle.description, aisle.categories, aisle.sequence]
      );
    }

    for (const area of layout.specialAreas) {
      await client.query(
        `INSERT INTO store_special_areas (store_id, area_type, area_name, sequence_order)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [storeId, area.type, area.name, area.sequence]
      );
    }

    const totalPoints = 200 + (layout.aisles.length * 15) + (layout.specialAreas.length * 10);

    await client.query(
      `UPDATE layout_contributions SET status = 'approved', aisles_contributed = $2,
       special_areas_contributed = $3, points_earned = $4, completed_at = NOW() WHERE id = $1`,
      [contributionId, layout.aisles.length, layout.specialAreas.length, totalPoints]
    );

    await client.query(
      `INSERT INTO user_rewards (user_id, total_points_earned, current_balance, total_contributions, total_aisles_mapped, total_stores_contributed)
       VALUES ($1, $2, $2, 1, $3, 1)
       ON CONFLICT (user_id) DO UPDATE SET
         total_points_earned = user_rewards.total_points_earned + $2,
         current_balance = user_rewards.current_balance + $2,
         total_contributions = user_rewards.total_contributions + 1,
         total_aisles_mapped = user_rewards.total_aisles_mapped + $3,
         total_stores_contributed = user_rewards.total_stores_contributed + 1, updated_at = NOW()`,
      [userId || '00000000-0000-0000-0000-000000000001', totalPoints, layout.aisles.length]
    );

    const aisleCount = await client.query('SELECT COUNT(*) FROM store_aisles WHERE store_id = $1', [storeId]);
    const coverage = Math.min(100, parseInt(aisleCount.rows[0].count) * 5);
    
    await client.query(
      `UPDATE stores SET is_mapped = true, mapping_coverage_percent = $2,
       total_contributions = total_contributions + 1, last_mapped_at = NOW() WHERE id = $1`,
      [storeId, coverage]
    );

    await client.query('COMMIT');
    console.log(`Video processing complete for contribution ${contributionId}`);

  } catch (error) {
    await client.query('ROLLBACK');
    await db.query(`UPDATE layout_contributions SET status = 'failed' WHERE id = $1`, [contributionId]);
    throw error;
  } finally {
    client.release();
  }
}

function extractVideoFrames(videoUrl) {
  const frames = [];
  for (let i = 0; i < 600; i += 10) {
    const frameUrl = videoUrl.replace(/\.(mp4|mov|avi)$/i, '.jpg').replace('/upload/', `/upload/so_${i}/`);
    frames.push(frameUrl);
  }
  return frames;
}

async function analyzeFrameWithOpenAI(frameUrl) {
  if (!OPENAI_API_KEY) return mockAnalyzeFrame();

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this grocery store image. If you see an aisle sign, return JSON: {"type": "aisle", "number": "X", "categories": ["cat1", "cat2"]}. If you see a special area sign (pharmacy, restroom, checkout, deli, bakery, entrance, exit), return: {"type": "area", "areaType": "type", "name": "name"}. If no sign visible: {"type": "none"}. Return ONLY valid JSON.' },
            { type: 'image_url', image_url: { url: frameUrl } }
          ]
        }],
        max_tokens: 300
      })
    });

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (content) {
      const parsed = JSON.parse(content);
      if (parsed.type !== 'none') return parsed;
    }
    return null;
  } catch (error) {
    console.error('OpenAI Vision error:', error);
    return null;
  }
}

function mockAnalyzeFrame() {
  const random = Math.random();
  if (random < 0.3) {
    const aisleNum = Math.floor(Math.random() * 12) + 1;
    const cats = [['Produce'],['Dairy','Milk'],['Meat','Seafood'],['Frozen'],['Snacks','Chips'],['Beverages'],['Cereal'],['Canned Goods'],['Baby','Pet'],['Health'],['Cleaning'],['Paper Products']];
    return { type: 'aisle', number: String(aisleNum), description: cats[aisleNum-1]?.join(', '), categories: cats[aisleNum-1] || ['General'] };
  } else if (random < 0.4) {
    const areas = ['pharmacy', 'restroom', 'checkout', 'deli', 'bakery', 'entrance'];
    const t = areas[Math.floor(Math.random() * areas.length)];
    return { type: 'area', areaType: t, name: t.charAt(0).toUpperCase() + t.slice(1) };
  }
  return null;
}

function organizeDetections(detections) {
  const aisleMap = new Map();
  const areaMap = new Map();

  for (const d of detections) {
    if (d.type === 'aisle' && !aisleMap.has(d.number)) {
      aisleMap.set(d.number, { number: d.number, description: d.description, categories: d.categories, sequence: d.sequence });
    } else if (d.type === 'area' && !areaMap.has(d.areaType)) {
      areaMap.set(d.areaType, { type: d.areaType, name: d.name, sequence: d.sequence });
    }
  }

  return {
    aisles: Array.from(aisleMap.values()).sort((a, b) => a.sequence - b.sequence),
    specialAreas: Array.from(areaMap.values()).sort((a, b) => a.sequence - b.sequence)
  };
}

module.exports = router;
