# Broker Pricing Editor - Setup Instructions

## Complete Implementation Checklist

This document provides step-by-step instructions to complete the broker pricing feature implementation.

---

## Step 1: Database Setup

### 1.1 Create the broker_pricing Table

Run the migration script in your database:

```bash
mysql -u your_username -p your_database < migrations/001_create_broker_pricing_table.sql
```

Or execute the SQL directly in your database client:

```sql
CREATE TABLE IF NOT EXISTS broker_pricing (
  id INT PRIMARY KEY AUTO_INCREMENT,
  broker_id INT NOT NULL,
  vehicle_type VARCHAR(100) NOT NULL,
  duration INT NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (broker_id) REFERENCES brokers(id) ON DELETE CASCADE,
  UNIQUE KEY unique_broker_vehicle_duration (broker_id, vehicle_type, duration),
  INDEX idx_broker_id (broker_id),
  INDEX idx_vehicle_duration (vehicle_type, duration),
  INDEX idx_broker_vehicle (broker_id, vehicle_type),
  INDEX idx_broker_duration (broker_id, duration)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 1.2 Insert Sample Data

Populate initial pricing data:

```bash
mysql -u your_username -p your_database < migrations/002_insert_sample_broker_pricing.sql
```

Or execute directly:

```sql
INSERT INTO broker_pricing (broker_id, vehicle_type, duration, price) VALUES
  (1, 'Auto', 15, 25.00),
  (1, 'Auto', 30, 45.00),
  (1, 'Auto', 90, 120.00),
  ... (see migrations/002_insert_sample_broker_pricing.sql for full list)
```

### 1.3 Verify Table Creation

```sql
SELECT * FROM broker_pricing LIMIT 5;
SHOW CREATE TABLE broker_pricing;
```

---

## Step 2: Backend API Implementation

### 2.1 Create Controller File

Copy the provided PHP controller to your project:

```bash
cp server_examples/BrokerPricingController.php your_api_dir/controllers/
```

### 2.2 Integrate with Your Router

Add routes to your API router:

**GET Route:**

```php
$app->get('/brokers/:brokerId/pricing', function($brokerId) {
    require_once 'controllers/BrokerPricingController.php';

    // Get your database connection
    $db = getDBConnection(); // Your DB function

    $controller = new BrokerPricingController($db);
    $response = $controller->getPricing($brokerId);

    header('Content-Type: application/json');
    echo json_encode($response);
});
```

**PUT Route:**

```php
$app->put('/brokers/:brokerId/pricing', function($brokerId) {
    require_once 'controllers/BrokerPricingController.php';

    // Verify user is authenticated and is an admin
    $userRole = authenticateAndGetRole(); // Your auth function
    if ($userRole !== 1) {
        http_response_code(403);
        echo json_encode(['error' => 'Unauthorized']);
        exit;
    }

    // Get your database connection
    $db = getDBConnection(); // Your DB function

    // Get JSON request body
    $requestBody = json_decode(file_get_contents('php://input'), true);

    $controller = new BrokerPricingController($db);
    $response = $controller->updatePricing($brokerId, $requestBody, $userRole);

    header('Content-Type: application/json');
    echo json_encode($response);
});
```

### 2.3 Alternative: Using Your Existing Framework

If you use Laravel, Symfony, or another framework, adapt the controller logic:

**Laravel Example:**

```php
Route::get('/brokers/{brokerId}/pricing', function($brokerId) {
    $controller = new BrokerPricingController(DB::connection()->getPdo());
    return response()->json($controller->getPricing($brokerId));
});

Route::put('/brokers/{brokerId}/pricing', function($brokerId) {
    $controller = new BrokerPricingController(DB::connection()->getPdo());
    return response()->json(
        $controller->updatePricing($brokerId, request()->json()->all(), auth()->user()->role)
    );
});
```

---

## Step 3: Frontend Integration (Already Completed)

The frontend is already implemented in:

- `renderer/common.js` - Translations and i18n
- `renderer/WorkPage/WorkPage.js` - Pricing editor modal and logic

**No frontend changes needed.** The application will automatically:

1. Show "View/Edit Pricing" button for admins in the brokers table
2. Open a modal when clicked
3. Fetch prices from `GET /brokers/{brokerId}/pricing`
4. Save changes via `PUT /brokers/{brokerId}/pricing`

---

## Step 4: Testing

### 4.1 Test Database

```sql
-- Check if table exists and has data
SELECT COUNT(*) as pricing_records FROM broker_pricing;

-- Check data structure
SELECT broker_id, vehicle_type, duration, price
FROM broker_pricing
WHERE broker_id = 1
ORDER BY vehicle_type, duration;
```

### 4.2 Test GET Endpoint

```bash
curl -X GET "http://localhost/api/brokers/1/pricing" \
  -H "Authorization: Bearer YOUR_TOKEN"
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

### 4.3 Test PUT Endpoint

```bash
curl -X PUT "http://localhost/api/brokers/1/pricing" \
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
    }
  }
}
```

### 4.4 Test Frontend

1. Log in as admin (role 1)
2. Navigate to "Brokers" in the admin dashboard
3. Click "View/Edit Pricing" button on any broker
4. Modal should open showing pricing table
5. Edit some prices
6. Click "Save"
7. Success message should appear
8. Prices should be saved in database

---

## Step 5: Production Deployment

### 5.1 Database Backup

Before deploying:

```bash
mysqldump -u username -p database_name > backup_$(date +%Y%m%d).sql
```

### 5.2 Run Migration

```bash
mysql -u username -p database_name < migrations/001_create_broker_pricing_table.sql
mysql -u username -p database_name < migrations/002_insert_sample_broker_pricing.sql
```

### 5.3 Deploy Backend Code

1. Copy `BrokerPricingController.php` to your server
2. Update your API routes
3. Clear any application caches
4. Test endpoints on staging before production

### 5.4 Frontend Already Deployed

The frontend code is already in:

- `renderer/common.js`
- `renderer/WorkPage/WorkPage.js`

Simply rebuild/restart your Electron app to pick up changes.

---

## Troubleshooting

### Issue: "404 Broker not found"

- **Solution:** Verify the broker_id exists in the brokers table
- **Check:** `SELECT * FROM brokers WHERE id = 1;`

### Issue: "Pricing table doesn't exist"

- **Solution:** Run the migration script (Step 1.1)
- **Verify:** `SHOW TABLES LIKE 'broker_pricing';`

### Issue: "Unauthorized: Only admins can update pricing"

- **Solution:** Make sure user role is 1 (admin)
- **Check:** User's role field should equal 1

### Issue: Modal doesn't open

- **Solution:** Check browser console for errors
- **Verify:** Admin is logged in (role should be 1)

### Issue: Prices not saving

- **Solution:** Check API response in Network tab of browser dev tools
- **Verify:** Database connection is working
- **Check:** `broker_pricing` table exists with sample data

### Issue: Foreign key constraint fails

- **Solution:** Broker ID doesn't exist
- **Fix:** Insert the broker first, then pricing
- **Check:** `SELECT id FROM brokers;`

---

## File Structure

```
InsuranceClient/
├── migrations/
│   ├── 001_create_broker_pricing_table.sql
│   └── 002_insert_sample_broker_pricing.sql
├── server_examples/
│   └── BrokerPricingController.php
├── renderer/
│   ├── common.js (UPDATED - new translations)
│   └── WorkPage/
│       └── WorkPage.js (UPDATED - pricing editor function)
├── BROKER_PRICING_API.md (Documentation)
├── IMPLEMENTATION_SUMMARY.md (Summary)
└── SETUP_INSTRUCTIONS.md (This file)
```

---

## Validation Checklist

- [ ] Database table `broker_pricing` created successfully
- [ ] Sample data inserted into broker_pricing
- [ ] GET endpoint returns pricing data correctly
- [ ] PUT endpoint updates pricing in database
- [ ] Authorization check prevents non-admins from updating
- [ ] Frontend modal opens when clicking "View/Edit Pricing"
- [ ] Prices display correctly in modal table
- [ ] Admin can edit prices in modal
- [ ] Save button submits data to server
- [ ] Success notification appears after save
- [ ] Broker list refreshes after update
- [ ] Error messages display properly for failures

---

## Support

If you encounter issues:

1. Check the Troubleshooting section above
2. Review the database schema in `001_create_broker_pricing_table.sql`
3. Check API response in browser Network tab
4. Review server error logs
5. Verify database connection and permissions
6. Ensure foreign keys are set up correctly

For detailed API specifications, see `BROKER_PRICING_API.md`
