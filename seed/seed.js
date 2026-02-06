// seed/seed.js
// ============================================================
// Smart Cart - Database Seed Data
// ============================================================

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function seed() {
  console.log('Seeding Smart Cart database...');

  try {
    // ── Demo User ──────────────────────────────────────────
    const passwordHash = await bcrypt.hash('Demo123!', 12);
    
    const userResult = await pool.query(`
      INSERT INTO users (name, email, password_hash) 
      VALUES ('Demo User', 'demo@smartcart.app', $1)
      ON CONFLICT (email) DO UPDATE SET name = 'Demo User'
      RETURNING id
    `, [passwordHash]);
    
    const userId = userResult.rows[0].id;
    console.log('✓ Created demo user');

    // ── User Settings ──────────────────────────────────────
    await pool.query(`
      INSERT INTO user_settings (user_id, dietary_restrictions, allergens)
      VALUES ($1, ARRAY['vegetarian', 'gluten-free'], ARRAY['nuts', 'shellfish'])
      ON CONFLICT (user_id) DO UPDATE SET 
        dietary_restrictions = ARRAY['vegetarian', 'gluten-free'],
        allergens = ARRAY['nuts', 'shellfish']
    `, [userId]);
    console.log('✓ Created user settings');

    // ── Family Members ─────────────────────────────────────
    await pool.query(`DELETE FROM family_members WHERE user_id = $1`, [userId]);
    await pool.query(`
      INSERT INTO family_members (user_id, name, relationship, dietary_restrictions, allergens) VALUES
      ($1, 'Emma', 'Daughter', ARRAY['dairy-free'], ARRAY['milk']),
      ($1, 'Michael', 'Spouse', ARRAY[]::text[], ARRAY['shellfish'])
    `, [userId]);
    console.log('✓ Created family members');

    // ── Shopping Lists ─────────────────────────────────────
    const listResult = await pool.query(`
      INSERT INTO shopping_lists (user_id, name, share_code)
      VALUES ($1, 'Weekly Groceries', 'ABC123')
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [userId]);

    let listId;
    if (listResult.rows.length > 0) {
      listId = listResult.rows[0].id;
    } else {
      const existingList = await pool.query(
        `SELECT id FROM shopping_lists WHERE user_id = $1 LIMIT 1`, [userId]
      );
      listId = existingList.rows[0]?.id;
    }

    if (listId) {
      await pool.query(`DELETE FROM list_items WHERE list_id = $1`, [listId]);
      await pool.query(`
        INSERT INTO list_items (list_id, name, price, quantity, department, checked, added_by) VALUES
        ($1, 'Organic Milk', 5.99, 1, 'Dairy', false, $2),
        ($1, 'Whole Wheat Bread', 3.49, 2, 'Bakery', false, $2),
        ($1, 'Free Range Eggs', 6.99, 1, 'Dairy', true, $2),
        ($1, 'Bananas', 0.59, 6, 'Produce', false, $2),
        ($1, 'Greek Yogurt', 4.99, 2, 'Dairy', false, $2)
      `, [listId, userId]);
      console.log('✓ Created shopping list with items');
    }

    // ── Second List ────────────────────────────────────────
    await pool.query(`
      INSERT INTO shopping_lists (user_id, name)
      VALUES ($1, 'BBQ Party Supplies')
      ON CONFLICT DO NOTHING
    `, [userId]);
    console.log('✓ Created second shopping list');

    // ── Recipes ────────────────────────────────────────────
    await pool.query(`
      INSERT INTO recipes (title, description, category, difficulty, time, servings, rating, image_url, ingredients, instructions, nutrition, is_featured) VALUES
      ('Classic Spaghetti Carbonara', 'A creamy Italian pasta dish with eggs, cheese, and bacon', 'Dinner', 'Medium', '30 min', 4, 4.8,
       'https://images.unsplash.com/photo-1612874742237-6526221588e3?w=400',
       '[{"name": "Spaghetti", "quantity": "1", "unit": "lb"}, {"name": "Bacon", "quantity": "8", "unit": "oz"}, {"name": "Eggs", "quantity": "4", "unit": ""}, {"name": "Parmesan", "quantity": "1", "unit": "cup"}, {"name": "Black pepper", "quantity": "1", "unit": "tsp"}]',
       '[{"step": 1, "text": "Cook spaghetti according to package directions"}, {"step": 2, "text": "Fry bacon until crispy"}, {"step": 3, "text": "Mix eggs with parmesan"}, {"step": 4, "text": "Toss hot pasta with egg mixture and bacon"}]',
       '{"calories": 650, "protein": 28, "carbs": 72, "fat": 28}',
       true),
      ('Avocado Toast', 'Simple and nutritious breakfast', 'Breakfast', 'Easy', '10 min', 2, 4.5,
       'https://images.unsplash.com/photo-1541519227354-08fa5d50c44d?w=400',
       '[{"name": "Bread", "quantity": "2", "unit": "slices"}, {"name": "Avocado", "quantity": "1", "unit": ""}, {"name": "Lemon juice", "quantity": "1", "unit": "tbsp"}, {"name": "Salt", "quantity": "", "unit": "to taste"}, {"name": "Red pepper flakes", "quantity": "", "unit": "optional"}]',
       '[{"step": 1, "text": "Toast bread until golden"}, {"step": 2, "text": "Mash avocado with lemon juice and salt"}, {"step": 3, "text": "Spread on toast and add toppings"}]',
       '{"calories": 280, "protein": 6, "carbs": 24, "fat": 18}',
       false),
      ('Greek Salad', 'Fresh Mediterranean salad', 'Lunch', 'Easy', '15 min', 4, 4.6,
       'https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?w=400',
       '[{"name": "Cucumber", "quantity": "1", "unit": ""}, {"name": "Tomatoes", "quantity": "3", "unit": ""}, {"name": "Red onion", "quantity": "1/2", "unit": ""}, {"name": "Feta cheese", "quantity": "1", "unit": "cup"}, {"name": "Olives", "quantity": "1/2", "unit": "cup"}, {"name": "Olive oil", "quantity": "3", "unit": "tbsp"}]',
       '[{"step": 1, "text": "Chop vegetables into bite-size pieces"}, {"step": 2, "text": "Combine in large bowl"}, {"step": 3, "text": "Top with feta and olives"}, {"step": 4, "text": "Drizzle with olive oil"}]',
       '{"calories": 220, "protein": 8, "carbs": 12, "fat": 16}',
       false),
      ('Chocolate Chip Cookies', 'Classic homemade cookies', 'Desserts', 'Easy', '45 min', 24, 4.9,
       'https://images.unsplash.com/photo-1499636136210-6f4ee915583e?w=400',
       '[{"name": "Flour", "quantity": "2.25", "unit": "cups"}, {"name": "Butter", "quantity": "1", "unit": "cup"}, {"name": "Sugar", "quantity": "0.75", "unit": "cup"}, {"name": "Brown sugar", "quantity": "0.75", "unit": "cup"}, {"name": "Eggs", "quantity": "2", "unit": ""}, {"name": "Chocolate chips", "quantity": "2", "unit": "cups"}]',
       '[{"step": 1, "text": "Cream butter and sugars"}, {"step": 2, "text": "Add eggs and vanilla"}, {"step": 3, "text": "Mix in flour and chips"}, {"step": 4, "text": "Bake at 375°F for 10-12 minutes"}]',
       '{"calories": 150, "protein": 2, "carbs": 20, "fat": 8}',
       false)
      ON CONFLICT DO NOTHING
    `);
    console.log('✓ Created sample recipes');

    // ── Stores ─────────────────────────────────────────────
    await pool.query(`
      INSERT INTO stores (name, address, latitude, longitude, rating, features, services, is_open) VALUES
      ('Walmart Neighborhood Market', '1819 S 8th St, Rogers, AR 72756', 36.3320, -94.1185, 4.2, 
       ARRAY['Parking', 'WiFi', 'Pharmacy'], ARRAY['grocery', 'Curbside', 'Delivery'], true),
      ('ALDI', '1316 W Walnut St, Rogers, AR 72756', 36.3380, -94.1300, 4.6,
       ARRAY['Parking'], ARRAY['grocery'], true),
      ('The Fresh Market', '2203 S Promenade Blvd, Rogers, AR 72758', 36.3250, -94.1350, 4.4,
       ARRAY['Organic', 'Deli', 'Parking'], ARRAY['grocery', 'Organic'], true),
      ('Whole Foods Market', '3300 Market St, Rogers, AR 72758', 36.3400, -94.1400, 4.5,
       ARRAY['Organic', 'Deli', 'Hot Bar', 'Parking'], ARRAY['grocery', 'Organic', 'Delivery'], true)
      ON CONFLICT DO NOTHING
    `);
    console.log('✓ Created sample stores');

    // ── Deals ──────────────────────────────────────────────
    await pool.query(`
      INSERT INTO deals (title, description, discount, store, category, is_active) VALUES
      ('Fresh Fruits Sale', 'All fresh fruits 50% off this weekend', '50% OFF', 'Walmart', 'Produce', true),
      ('Buy 2 Get 1 Free', 'On all dairy products', 'B2G1', 'Smart Cart', 'Dairy', true),
      ('Bakery Special', 'Fresh bread and pastries 30% off', '30% OFF', 'Target', 'Bakery', true),
      ('Meat Monday', 'Premium cuts 25% off every Monday', '25% OFF', 'Kroger', 'Meat', true)
      ON CONFLICT DO NOTHING
    `);
    console.log('✓ Created sample deals');

    // ── Shopping History ───────────────────────────────────
    await pool.query(`
      INSERT INTO shopping_trips (user_id, store_name, total, item_count, note, trip_date) VALUES
      ($1, 'Walmart Supercenter', 14.47, 3, 'Found everything on the list quickly', NOW() - INTERVAL '2 days'),
      ($1, 'ALDI', 32.89, 8, 'Great prices on produce', NOW() - INTERVAL '5 days'),
      ($1, 'Whole Foods', 67.23, 12, 'Stocked up on organic items', NOW() - INTERVAL '1 week')
      ON CONFLICT DO NOTHING
    `, [userId]);
    console.log('✓ Created shopping history');

    console.log('\n✅ Database seeded successfully!');
    console.log('\n📧 Demo login credentials:');
    console.log('   Email: demo@smartcart.app');
    console.log('   Password: Demo123!');

  } catch (error) {
    console.error('❌ Seed failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

seed();
