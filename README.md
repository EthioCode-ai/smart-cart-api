# Smart Cart API

Backend API for the Smart Cart mobile app - AI-powered grocery shopping with AR navigation and crowdsourced store mapping.

## Features

- 🏪 **Store Discovery** - Find nearby stores with GPS
- 📍 **Pin New Stores** - Users can add stores to the map
- 🗺️ **Store Layouts** - Aisle mapping and navigation
- 📸 **Crowdsourced Mapping** - Users contribute store layouts
- 🎮 **Gamification** - Earn points for contributions
- 🛒 **Route Optimization** - Optimal shopping path calculation

## API Endpoints

### Stores
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stores/nearby` | Get nearby stores |
| GET | `/api/stores/search` | Search stores |
| GET | `/api/stores/:id` | Get store details |
| POST | `/api/stores/pin` | Pin a new store |
| PATCH | `/api/stores/:id/attributes` | Update store attributes |

### Layouts
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/layouts/:storeId` | Get store layout |
| POST | `/api/layouts/:storeId/route` | Get optimized shopping route |
| POST | `/api/layouts/:storeId/products/locate` | Find product locations |

### Contributions
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/contributions` | Submit layout contribution |
| GET | `/api/contributions/mine` | Get user's contributions |

### Rewards
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/rewards/mine` | Get user's rewards |
| GET | `/api/rewards/catalog` | Get available rewards |
| POST | `/api/rewards/redeem` | Redeem points |
| GET | `/api/rewards/leaderboard` | Get contributor leaderboard |

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | Get current user |

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Variables
Create a `.env` file:
```
DATABASE_URL=postgresql://user:pass@host/dbname
JWT_SECRET=your-secret-key
PORT=3000
NODE_ENV=development
```

### 3. Run Database Setup
```bash
node src/db/setup.js
```

### 4. Start Server
```bash
# Development
npm run dev

# Production
npm start
```

## Deploy to Render

1. Create a new Web Service on Render
2. Connect your GitHub repo
3. Set environment variables:
   - `DATABASE_URL` (use Internal URL from your Render PostgreSQL)
   - `JWT_SECRET`
   - `NODE_ENV=production`
4. Build Command: `npm install`
5. Start Command: `npm start`

## Example Requests

### Get Nearby Stores
```bash
curl "http://localhost:3000/api/stores/nearby?latitude=37.3382&longitude=-121.8863&radius=5"
```

### Pin a New Store
```bash
curl -X POST http://localhost:3000/api/stores/pin \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Costco Wholesale",
    "chain": "Costco",
    "address": {
      "addressLine1": "123 Warehouse Way",
      "city": "San Jose",
      "state": "CA",
      "zipCode": "95123"
    },
    "location": {
      "latitude": 37.3400,
      "longitude": -121.8900
    }
  }'
```

### Submit Layout Contribution
```bash
curl -X POST http://localhost:3000/api/contributions \
  -H "Content-Type: application/json" \
  -d '{
    "storeId": "store-uuid-here",
    "userLocation": { "latitude": 37.3382, "longitude": -121.8863 },
    "aisles": [
      { "aisleNumber": "A1", "description": "Produce", "categories": ["Fruits", "Vegetables"] },
      { "aisleNumber": "A2", "description": "Dairy", "categories": ["Milk", "Cheese", "Yogurt"] }
    ],
    "specialAreas": [
      { "areaType": "entrance", "areaName": "Main Entrance" },
      { "areaType": "checkout", "areaName": "Checkout Lanes" }
    ]
  }'
```

## Points System

| Action | Points |
|--------|--------|
| Map an aisle | 10 |
| Add photo | +5 bonus |
| Tag category | +2 each |
| Mark special area | 5 |

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** PostgreSQL
- **Auth:** JWT
- **Hosting:** Render
