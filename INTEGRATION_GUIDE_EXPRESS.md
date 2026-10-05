# Broker Pricing API - Express.js Integration Guide

## Overview

The broker pricing feature requires two new API endpoints in your Express.js backend:

- `GET /brokers/:brokerId/pricing` - Retrieve broker pricing
- `PUT /brokers/:brokerId/pricing` - Update broker pricing

## Prerequisites

1. ✅ Database table `broker_pricing` created (see `SETUP_INSTRUCTIONS.md` Step 1)
2. ✅ Sample data inserted (migrations/002_insert_sample_broker_pricing.sql)
3. ✅ Express.js server running
4. ✅ MySQL database with broker_pricing table

## Integration Steps

### Step 1: Import the Routes

Add this to your main Express app file (e.g., `server.js`, `app.js`, or `index.js`):

```javascript
// At the top with other imports
const {
  getBrokerPricing,
  updateBrokerPricing,
} = require("./routes/brokerPricing");
// OR from server_examples if you copied it there
// const { getBrokerPricing, updateBrokerPricing } = require('../InsuranceClient/server_examples/brokerPricingRoutes');
```

### Step 2: Register the Routes

Add these routes to your Express app. They should go BEFORE your catch-all 404 handler:

```javascript
// Broker Pricing endpoints
app.get("/brokers/:brokerId/pricing", getBrokerPricing);
app.put("/brokers/:brokerId/pricing", updateBrokerPricing);
```

**Complete example:**

```javascript
const express = require("express");
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Your authentication middleware
app.use(authenticateToken); // Adjust based on your auth setup

// Import broker pricing routes
const {
  getBrokerPricing,
  updateBrokerPricing,
} = require("./routes/brokerPricing");

// Existing broker routes
app.get("/brokers", getBrokers);
app.post("/brokers", createBroker);
app.patch("/brokers/:id", updateBroker);
app.delete("/brokers/:id", deleteBroker);

// NEW: Broker pricing routes (must be AFTER the broker routes above)
app.get("/brokers/:brokerId/pricing", getBrokerPricing);
app.put("/brokers/:brokerId/pricing", updateBrokerPricing);

// Other routes...
app.post("/brokers/:id/increase", increaseBrokerBalance);
app.post("/brokers/:id/reduce", reduceBrokerBalance);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
```

### Step 3: Ensure Database Connection is Available

The route handlers expect the database to be accessible. You need to make sure your database connection is available in one of these ways:

**Option A: Store in app.locals (Recommended)**

```javascript
// After creating your database pool/connection
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Make it available to routes
app.locals.db = pool;
```

**Option B: Attach to request object**

```javascript
// Middleware that attaches database to each request
app.use((req, res, next) => {
  req.db = pool; // Your database connection
  next();
});
```

**Option C: Pass via module exports**

```javascript
// In your route file at the top
let db;

function setDatabase(database) {
  db = database;
}

// Then call setDatabase(pool) from your main app file before registering routes
module.exports = { getBrokerPricing, updateBrokerPricing, setDatabase };
```

### Step 4: Verify Authentication Middleware

Make sure your authentication middleware is set up to:

1. **Extract user role** from JWT token
2. **Attach to req.user or req.userRole**

Example middleware:

```javascript
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "No token provided" });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ error: "Invalid token" });
    }
    req.user = user; // Make sure this includes role: user.role
    req.userRole = user.role; // Also set userRole for compatibility
    next();
  });
}
```

## Database Query Compatibility

The routes use `db.query()` method. Ensure your database library supports this:

**mysql2/promise:**

```javascript
const pool = mysql.createPool({ ... });
const rows = await pool.query('SELECT * FROM brokers WHERE id = ?', [id]);
// Returns array of arrays, access with rows[0]
```

**If using different syntax**, update the handlers to match your database library:

```javascript
// For callback-based drivers
db.query(sql, params, (error, results) => {
  // Handle results
});

// For custom query functions
const results = await db.execute(sql, params);
```

## Testing the Endpoints

### Test GET endpoint:

```bash
curl -X GET "http://localhost:3000/brokers/1/pricing" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"
```

Expected response:

```json
{
  "success": true,
  "pricing": {
    "Auto": {
      "15": 25.0,
      "30": 45.0,
      "90": 120.0
    },
    "Motor": {
      "15": 20.0,
      "30": 38.0,
      "90": 100.0
    }
  }
}
```

### Test PUT endpoint:

```bash
curl -X PUT "http://localhost:3000/brokers/1/pricing" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pricing": {
      "Auto": {"15": 26.00, "30": 46.00, "90": 121.00},
      "Motor": {"15": 21.00, "30": 39.00, "90": 101.00}
    }
  }'
```

Expected response:

```json
{
  "success": true,
  "message": "Pricing updated successfully",
  "pricing": {
    "Auto": {
      "15": 26.0,
      "30": 46.0,
      "90": 121.0
    },
    "Motor": {
      "15": 21.0,
      "30": 39.0,
      "90": 101.0
    }
  }
}
```

## Error Responses

### Invalid Broker ID (400)

```json
{
  "success": false,
  "error": "Invalid broker ID"
}
```

### Broker Not Found (404)

```json
{
  "success": false,
  "error": "Broker not found"
}
```

### Unauthorized - Not Admin (403)

```json
{
  "success": false,
  "error": "Unauthorized: Only admins can update pricing"
}
```

### Invalid Pricing Format (400)

```json
{
  "success": false,
  "error": "Invalid pricing data format"
}
```

## Common Issues & Solutions

### Issue: "Database connection not available"

**Solution:** Ensure database is attached to app.locals or req object:

```javascript
// In your app setup
app.locals.db = your_database_connection;
```

### Issue: "Broker not found" when broker exists

**Solution:** Check broker_id in URL matches database:

```javascript
// Debug
console.log("Looking for broker:", brokerId);
// Then check if broker exists
db.query("SELECT * FROM brokers WHERE id = ?", [brokerId]);
```

### Issue: "Only admins can update pricing" error

**Solution:** Ensure user role is extracted correctly:

```javascript
// Check middleware is setting req.user or req.userRole
console.log("User role:", req.user?.role || req.userRole);
// Should be 1 or "1" for admin
```

### Issue: Prices not updating

**Solution:** Verify broker_pricing table exists:

```sql
SHOW TABLES LIKE 'broker_pricing';
DESC broker_pricing;
```

If table doesn't exist, run migration:

```bash
mysql -u user -p database < migrations/001_create_broker_pricing_table.sql
mysql -u user -p database < migrations/002_insert_sample_broker_pricing.sql
```

## File Locations

- **Route handlers:** `server_examples/brokerPricingRoutes.js` (from this InsuranceClient repo)
- **Database migrations:** `migrations/001_create_broker_pricing_table.sql`
- **Sample data:** `migrations/002_insert_sample_broker_pricing.sql`
- **API documentation:** `BROKER_PRICING_API.md`
- **Setup instructions:** `SETUP_INSTRUCTIONS.md`

## Next Steps

1. ✅ Copy `brokerPricingRoutes.js` to your InsuranceServer project
2. ✅ Import and register routes in your Express app
3. ✅ Ensure database connection is available to routes
4. ✅ Test endpoints with curl commands above
5. ✅ Verify 404 error is resolved
6. ✅ Test in frontend: Brokers tab → View/Edit Pricing button

## Support

If you encounter issues:

1. Check server logs for error messages
2. Verify database connection works: `SELECT * FROM broker_pricing LIMIT 1;`
3. Test endpoints with curl before testing in frontend
4. Check user token has admin role (role = 1)
5. Verify `broker_pricing` table exists with correct schema
