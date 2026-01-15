-- Users table for authentication
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    avatar_url VARCHAR(500),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Add user_id foreign key constraints (if not already added)
-- Note: These may fail if tables don't exist yet, that's okay

-- Sample test user (password: testpass123)
INSERT INTO users (id, email, password_hash, name)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'test@smartcart.com',
    '$2a$10$rG8J5G8Q5jK3X5Y5Z5V5V.5G8J5G8Q5jK3X5Y5Z5V5V5G8J5G8Q5j',
    'Test User'
) ON CONFLICT (id) DO NOTHING;
