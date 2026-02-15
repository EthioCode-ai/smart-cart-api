-- ============================================================
-- 002_store_layouts.sql
-- AR Store Layout Contribution System
-- ============================================================

-- ── Store Entrances ─────────────────────────────────────────
-- Marks the entry/exit points of a store for route planning
CREATE TABLE IF NOT EXISTS store_entrances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    entrance_type VARCHAR(30) NOT NULL DEFAULT 'main'
        CHECK (entrance_type IN ('main', 'side', 'back', 'pharmacy', 'garden', 'restrooms', 'cash_registers', 'self_checkout', 'customer_service', 'deli_counter', 'bakery_counter', 'returns_desk', 'atm', 'photo_center', 'floral', 'garden_center', 'main_entrance', 'side_entrance')),
    position_description VARCHAR(255),
    latitude DECIMAL(10, 7),
    longitude DECIMAL(10, 7),
    created_by UUID REFERENCES users(id),
    verified_count INTEGER DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_store_entrances_store ON store_entrances(store_id);

-- ── Store Aisles ────────────────────────────────────────────
-- Individual aisles within a store, crowd-sourced and scored
CREATE TABLE IF NOT EXISTS store_aisles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    aisle_number VARCHAR(10) NOT NULL,
    aisle_label VARCHAR(255),
    position_index INTEGER,
    confidence_score DECIMAL(5, 2) DEFAULT 50.00
        CHECK (confidence_score >= 0 AND confidence_score <= 100),
    verified_count INTEGER DEFAULT 1,
    last_verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(store_id, aisle_number)
);

CREATE INDEX IF NOT EXISTS idx_store_aisles_store ON store_aisles(store_id);
CREATE INDEX IF NOT EXISTS idx_store_aisles_confidence ON store_aisles(store_id, confidence_score DESC);

-- ── Aisle Departments ───────────────────────────────────────
-- Maps departments (dairy, produce, etc.) to specific aisles
CREATE TABLE IF NOT EXISTS aisle_departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aisle_id UUID NOT NULL REFERENCES store_aisles(id) ON DELETE CASCADE,
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    department_name VARCHAR(50) NOT NULL,
    confidence_score DECIMAL(5, 2) DEFAULT 50.00
        CHECK (confidence_score >= 0 AND confidence_score <= 100),
    verified_count INTEGER DEFAULT 1,
    last_verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(aisle_id, department_name)
);

CREATE INDEX IF NOT EXISTS idx_aisle_departments_aisle ON aisle_departments(aisle_id);
CREATE INDEX IF NOT EXISTS idx_aisle_departments_store ON aisle_departments(store_id);
CREATE INDEX IF NOT EXISTS idx_aisle_departments_name ON aisle_departments(department_name);

-- ── Aisle Products ──────────────────────────────────────────
-- Product categories within a department-aisle mapping
CREATE TABLE IF NOT EXISTS aisle_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id UUID NOT NULL REFERENCES aisle_departments(id) ON DELETE CASCADE,
    product_category VARCHAR(100) NOT NULL,
    product_subcategory VARCHAR(100),
    confidence_score DECIMAL(5, 2) DEFAULT 50.00
        CHECK (confidence_score >= 0 AND confidence_score <= 100),
    verified_count INTEGER DEFAULT 1,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(department_id, product_category)
);

CREATE INDEX IF NOT EXISTS idx_aisle_products_dept ON aisle_products(department_id);
CREATE INDEX IF NOT EXISTS idx_aisle_products_category ON aisle_products(product_category);

-- ── Layout Contributions ────────────────────────────────────
-- Every user action that adds/confirms/reports layout data
CREATE TABLE IF NOT EXISTS layout_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    aisle_id UUID REFERENCES store_aisles(id) ON DELETE SET NULL,
    contribution_type VARCHAR(20) NOT NULL
        CHECK (contribution_type IN ('scan', 'manual', 'confirm', 'report', 'entrance')),
    ocr_text TEXT,
    ocr_confidence DECIMAL(5, 2),
    image_url VARCHAR(500),
    data JSONB,
    status VARCHAR(20) DEFAULT 'approved'
        CHECK (status IN ('pending', 'approved', 'rejected', 'flagged')),
    points_awarded INTEGER DEFAULT 0,
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contributions_store ON layout_contributions(store_id);
CREATE INDEX IF NOT EXISTS idx_contributions_user ON layout_contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_contributions_status ON layout_contributions(status);
CREATE INDEX IF NOT EXISTS idx_contributions_created ON layout_contributions(created_at DESC);

-- ── User Points ─────────────────────────────────────────────
-- Aggregate points and level per user
CREATE TABLE IF NOT EXISTS user_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
    total_points INTEGER DEFAULT 0,
    level INTEGER DEFAULT 1,
    contributions_count INTEGER DEFAULT 0,
    stores_mapped INTEGER DEFAULT 0,
    streak_days INTEGER DEFAULT 0,
    last_contribution_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_points_total ON user_points(total_points DESC);
CREATE INDEX IF NOT EXISTS idx_user_points_level ON user_points(level DESC);

-- ── Point Transactions ──────────────────────────────────────
-- Audit trail of every point earned or spent
CREATE TABLE IF NOT EXISTS point_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    points INTEGER NOT NULL,
    reason VARCHAR(50) NOT NULL
        CHECK (reason IN (
            'aisle_scan', 'aisle_manual', 'aisle_confirm', 
            'data_report', 'entrance_map', 'first_store_bonus',
            'store_complete_bonus', 'streak_bonus', 'weekly_challenge'
        )),
    contribution_id UUID REFERENCES layout_contributions(id) ON DELETE SET NULL,
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_point_transactions_user ON point_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_point_transactions_created ON point_transactions(created_at DESC);

-- ── User Badges ─────────────────────────────────────────────
-- Achievement badges earned by users
CREATE TABLE IF NOT EXISTS user_badges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    badge_type VARCHAR(50) NOT NULL,
    badge_name VARCHAR(100) NOT NULL,
    badge_description VARCHAR(255),
    store_id UUID REFERENCES stores(id) ON DELETE SET NULL,
    earned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, badge_type, store_id)
);

CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);

-- ── Store Layout Stats (Materialized View) ──────────────────
-- Cached stats for quick lookup on store completion
CREATE TABLE IF NOT EXISTS store_layout_stats (
    store_id UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
    total_aisles INTEGER DEFAULT 0,
    mapped_aisles INTEGER DEFAULT 0,
    total_departments INTEGER DEFAULT 0,
    total_products INTEGER DEFAULT 0,
    total_contributions INTEGER DEFAULT 0,
    unique_contributors INTEGER DEFAULT 0,
    avg_confidence DECIMAL(5, 2) DEFAULT 0,
    completion_percentage DECIMAL(5, 2) DEFAULT 0,
    last_contribution_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── Department Reference Data ───────────────────────────────
-- Standard department names for normalization and OCR matching
CREATE TABLE IF NOT EXISTS department_reference (
    id SERIAL PRIMARY KEY,
    department_name VARCHAR(50) NOT NULL UNIQUE,
    display_name VARCHAR(50) NOT NULL,
    icon VARCHAR(50),
    color VARCHAR(7),
    common_aliases TEXT[],
    sort_order INTEGER DEFAULT 99
);

-- Seed standard grocery departments
INSERT INTO department_reference (department_name, display_name, icon, color, common_aliases, sort_order) VALUES
    ('produce', 'Produce', 'leaf-outline', '#22C55E', ARRAY['fruits', 'vegetables', 'fresh produce', 'organic'], 1),
    ('dairy', 'Dairy', 'water-outline', '#3B82F6', ARRAY['milk', 'cheese', 'yogurt', 'eggs', 'butter'], 2),
    ('meat', 'Meat & Seafood', 'flame-outline', '#EF4444', ARRAY['poultry', 'beef', 'pork', 'fish', 'seafood', 'deli meat'], 3),
    ('bakery', 'Bakery', 'cafe-outline', '#F59E0B', ARRAY['bread', 'pastry', 'cakes', 'rolls', 'baked goods'], 4),
    ('deli', 'Deli', 'restaurant-outline', '#F97316', ARRAY['prepared foods', 'salads', 'sandwiches', 'hot food'], 5),
    ('frozen', 'Frozen Foods', 'snow-outline', '#06B6D4', ARRAY['frozen', 'ice cream', 'frozen meals', 'frozen vegetables'], 6),
    ('pantry', 'Pantry & Dry Goods', 'cube-outline', '#8B5CF6', ARRAY['canned goods', 'pasta', 'rice', 'cereals', 'snacks', 'chips'], 7),
    ('beverages', 'Beverages', 'beer-outline', '#EC4899', ARRAY['drinks', 'soda', 'juice', 'water', 'coffee', 'tea'], 8),
    ('condiments', 'Condiments & Sauces', 'flask-outline', '#14B8A6', ARRAY['sauces', 'dressings', 'spices', 'seasonings', 'oils'], 9),
    ('household', 'Household', 'home-outline', '#64748B', ARRAY['cleaning', 'paper goods', 'trash bags', 'laundry'], 10),
    ('personal_care', 'Personal Care', 'body-outline', '#A855F7', ARRAY['health', 'beauty', 'hygiene', 'pharmacy', 'vitamins'], 11),
    ('baby', 'Baby & Kids', 'happy-outline', '#FB923C', ARRAY['diapers', 'formula', 'baby food', 'kids'], 12),
    ('pet', 'Pet Supplies', 'paw-outline', '#84CC16', ARRAY['dog food', 'cat food', 'pet care'], 13),
    ('alcohol', 'Beer, Wine & Spirits', 'wine-outline', '#7C3AED', ARRAY['beer', 'wine', 'liquor', 'spirits'], 14),
    ('international', 'International Foods', 'globe-outline', '#0EA5E9', ARRAY['ethnic', 'asian', 'hispanic', 'italian', 'indian'], 15),
    ('other', 'Other', 'ellipsis-horizontal', '#9CA3AF', ARRAY[]::TEXT[], 99)
ON CONFLICT (department_name) DO NOTHING;

-- ── Level Thresholds Reference ──────────────────────────────
CREATE TABLE IF NOT EXISTS level_thresholds (
    level INTEGER PRIMARY KEY,
    min_points INTEGER NOT NULL,
    title VARCHAR(50) NOT NULL
);

INSERT INTO level_thresholds (level, min_points, title) VALUES
    (1, 0, 'Shopper'),
    (2, 100, 'Explorer'),
    (3, 300, 'Navigator'),
    (4, 600, 'Pathfinder'),
    (5, 1000, 'Store Guide'),
    (6, 1500, 'Layout Expert'),
    (7, 2500, 'Master Mapper'),
    (8, 4000, 'Store Architect'),
    (9, 6000, 'Community Leader'),
    (10, 10000, 'Legend')
ON CONFLICT (level) DO NOTHING;

-- ── Point Values Reference ──────────────────────────────────
CREATE TABLE IF NOT EXISTS point_values (
    action VARCHAR(50) PRIMARY KEY,
    points INTEGER NOT NULL,
    description VARCHAR(255)
);

INSERT INTO point_values (action, points, description) VALUES
    ('aisle_scan', 50, 'Scan an aisle sign with camera (new aisle)'),
    ('aisle_manual', 30, 'Manually tag an aisle with departments'),
    ('aisle_confirm', 10, 'Confirm existing aisle data is correct'),
    ('data_report', 15, 'Report incorrect aisle data'),
    ('entrance_map', 25, 'Map a store entrance'),
    ('first_store_bonus', 200, 'First person to start mapping a store'),
    ('store_complete_bonus', 500, 'Complete 80%+ of a store layout'),
    ('streak_bonus', 25, 'Bonus for consecutive daily contributions'),
    ('weekly_challenge', 100, 'Complete a weekly mapping challenge')
ON CONFLICT (action) DO NOTHING;